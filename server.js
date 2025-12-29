require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { createServer } = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const ORSClient = require('./lib/ors-client');
const sharp = require('sharp');
const exifr = require('exifr');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

// Configure ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ============================================
// PERSISTENT DATA CONFIGURATION
// ============================================
// On Render: /var/data (persistent disk mount)
// Local dev: ./data (for development)
const DATA_DIR = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/var/data' : './data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'roadtrip.db');

// ============================================
// ENSURE DIRECTORIES EXIST
// ============================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ============================================
// DATABASE SETUP
// ============================================
const db = new Database(DB_PATH);

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    picture TEXT,
    role TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    city TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    date TEXT NOT NULL,
    nights INTEGER DEFAULT 0,
    type TEXT DEFAULT 'normal',
    note TEXT,
    is_start INTEGER DEFAULT 0,
    is_end INTEGER DEFAULT 0,
    fog_zone INTEGER DEFAULT 0,
    order_index INTEGER,
    completed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS live_location (
    id INTEGER PRIMARY KEY,
    lat REAL,
    lng REAL,
    accuracy REAL,
    speed REAL,
    heading REAL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT,
    lat REAL,
    lng REAL,
    caption TEXT,
    stop_id INTEGER,
    include_in_story INTEGER DEFAULT 1,
    story_order INTEGER,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stop_id) REFERENCES stops(id)
  );

  CREATE TABLE IF NOT EXISTS story_text_slides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text_content TEXT NOT NULL,
    story_order INTEGER,
    position_after_photo_id TEXT,
    stop_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (position_after_photo_id) REFERENCES photos(id) ON DELETE CASCADE,
    FOREIGN KEY (stop_id) REFERENCES stops(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS route_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_stop_id INTEGER NOT NULL,
    to_stop_id INTEGER NOT NULL,
    geometry TEXT NOT NULL,
    distance_meters INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    bbox TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_stop_id) REFERENCES stops(id) ON DELETE CASCADE,
    FOREIGN KEY (to_stop_id) REFERENCES stops(id) ON DELETE CASCADE,
    UNIQUE(from_stop_id, to_stop_id)
  );

  CREATE INDEX IF NOT EXISTS idx_route_segments_stops
    ON route_segments(from_stop_id, to_stop_id);

  CREATE TABLE IF NOT EXISTS live_route_progress (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    from_lat REAL,
    from_lng REAL,
    to_stop_id INTEGER,
    next_stop_id INTEGER,
    geometry TEXT,
    distance_meters INTEGER,
    duration_seconds INTEGER,
    is_active INTEGER DEFAULT 0,
    resting_for_night INTEGER DEFAULT 0,
    resting_location TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (to_stop_id) REFERENCES stops(id) ON DELETE SET NULL,
    FOREIGN KEY (next_stop_id) REFERENCES stops(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS user_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    disconnected_at DATETIME,
    is_online INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_user_analytics_user
    ON user_analytics(user_id, connected_at);

  CREATE INDEX IF NOT EXISTS idx_user_analytics_online
    ON user_analytics(user_id, is_online);
`);

// Migrations: Add new columns to existing live_route_progress table
try {
  db.prepare('ALTER TABLE live_route_progress ADD COLUMN next_stop_id INTEGER REFERENCES stops(id) ON DELETE SET NULL').run();
} catch (e) {
  // Column already exists, ignore
}

try {
  db.prepare('ALTER TABLE live_route_progress ADD COLUMN resting_for_night INTEGER DEFAULT 0').run();
} catch (e) {
  // Column already exists, ignore
}

try {
  db.prepare('ALTER TABLE live_route_progress ADD COLUMN resting_location TEXT').run();
} catch (e) {
  // Column already exists, ignore
}

try {
  db.prepare('ALTER TABLE stops ADD COLUMN completed INTEGER DEFAULT 0').run();
} catch (e) {
  // Column already exists, ignore
}

try {
  db.prepare('ALTER TABLE photos ADD COLUMN include_in_story INTEGER DEFAULT 1').run();
} catch (e) {
  // Column already exists, ignore
}

try {
  db.prepare('ALTER TABLE photos ADD COLUMN story_order INTEGER').run();
} catch (e) {
  // Column already exists, ignore
}

try {
  db.prepare('ALTER TABLE story_text_slides ADD COLUMN story_order INTEGER').run();
} catch (e) {
  // Column already exists, ignore
}

// Insert default admin if not exists (first user to login becomes admin)
const adminCheck = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_email');
if (!adminCheck) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_email', '');
}

// Insert default stops if none exist
const stopsCount = db.prepare('SELECT COUNT(*) as count FROM stops').get();
if (stopsCount.count === 0) {
  const defaultStops = [
    { city: "Bengaluru", lat: 12.9716, lng: 77.5946, date: "2025-12-24", nights: 0, type: "workday", note: "Starting Point", is_start: 1, order_index: 0 },
    { city: "Vizag", lat: 17.6868, lng: 83.2185, date: "2025-12-24", nights: 1, type: "workday", note: "", order_index: 1 },
    { city: "Puri", lat: 19.8135, lng: 85.8312, date: "2025-12-25", nights: 1, type: "holiday", note: "Christmas", order_index: 2 },
    { city: "Kolkata", lat: 22.5726, lng: 88.3639, date: "2025-12-26", nights: 1, type: "workday", note: "", order_index: 3 },
    { city: "Siliguri", lat: 26.7271, lng: 88.3953, date: "2025-12-27", nights: 2, type: "normal", note: "Buffer days", order_index: 4 },
    { city: "Phuentsholing", lat: 26.8516, lng: 89.3884, date: "2025-12-30", nights: 1, type: "workday", note: "🇧🇹 Bhutan Entry", order_index: 5 },
    { city: "Thimphu", lat: 27.4716, lng: 89.6386, date: "2025-12-31", nights: 1, type: "workday", note: "🇧🇹 NYE", order_index: 6 },
    { city: "Paro", lat: 27.4287, lng: 89.4164, date: "2026-01-01", nights: 1, type: "holiday", note: "🇧🇹 Tiger's Nest", order_index: 7 },
    { city: "Siliguri", lat: 26.7271, lng: 88.3953, date: "2026-01-02", nights: 1, type: "workday", note: "Return from Bhutan", order_index: 8 },
    { city: "Patna", lat: 25.5941, lng: 85.1376, date: "2026-01-03", nights: 1, type: "holiday", note: "", fog_zone: 1, order_index: 9 },
    { city: "Varanasi", lat: 25.3176, lng: 82.9739, date: "2026-01-04", nights: 1, type: "holiday", note: "Ganga Aarti", fog_zone: 1, order_index: 10 },
    { city: "Bhedaghat", lat: 23.1095, lng: 79.8804, date: "2026-01-05", nights: 2, type: "workday", note: "Marble Rocks", order_index: 11 },
    { city: "Indore", lat: 22.7196, lng: 75.8577, date: "2026-01-07", nights: 2, type: "workday", note: "Final Stop - Sarafa Bazaar", is_end: 1, order_index: 12 }
  ];

  const insertStop = db.prepare(`
    INSERT INTO stops (city, lat, lng, date, nights, type, note, is_start, is_end, fog_zone, order_index)
    VALUES (@city, @lat, @lng, @date, @nights, @type, @note, @is_start, @is_end, @fog_zone, @order_index)
  `);

  defaultStops.forEach(stop => {
    insertStop.run({
      ...stop,
      is_start: stop.is_start || 0,
      is_end: stop.is_end || 0,
      fog_zone: stop.fog_zone || 0
    });
  });
}

// Initialize live location row
const liveLocCheck = db.prepare('SELECT * FROM live_location WHERE id = 1').get();
if (!liveLocCheck) {
  db.prepare('INSERT INTO live_location (id, lat, lng) VALUES (1, NULL, NULL)').run();
}

// Initialize live route progress row
const liveRouteCheck = db.prepare('SELECT * FROM live_route_progress WHERE id = 1').get();
if (!liveRouteCheck) {
  db.prepare('INSERT INTO live_route_progress (id, is_active) VALUES (1, 0)').run();
}

// ============================================
// MIDDLEWARE
// ============================================
// Trust proxy - required for secure cookies behind reverse proxies (Render, Heroku, etc.)
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static('public'));

// Custom video streaming with HTTP range support
app.get('/uploads/:filename', (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  // Check if this is a video file
  const isVideo = /\.(mp4|mov|avi|webm|mkv)$/i.test(req.params.filename);

  if (range && isVideo) {
    // Parse range header
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    // Serve full file for non-video or non-range requests
    const head = {
      'Content-Length': fileSize,
      'Content-Type': isVideo ? 'video/mp4' : 'image/jpeg',
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// Session configuration with persistent SQLite storage
const sessionMiddleware = session({
  store: new SqliteStore({
    client: db,
    expired: {
      clear: true,
      intervalMs: 900000 // Clear expired sessions every 15 minutes
    }
  }),
  secret: process.env.SESSION_SECRET || 'roadtrip-secret-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax', // Allow cookies on OAuth redirects
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
});

app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

// Share session with Socket.IO for user analytics tracking
io.engine.use(sessionMiddleware);

// ============================================
// PASSPORT GOOGLE OAUTH
// ============================================
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/auth/google/callback`
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    const existingUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    
    if (existingUser) {
      return done(null, existingUser);
    }

    // Check if this is the first user (becomes admin)
    const adminEmail = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_email');
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const role = (!adminEmail?.value || userCount.count === 0) ? 'admin' : 'pending';

    const userId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, email, name, picture, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, email, profile.displayName, profile.photos[0]?.value, role);

    if (role === 'admin') {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(email, 'admin_email');
    }

    const newUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    // Notify admins of new user sign-up
    io.emit('new_user_signup', {
      name: newUser.name,
      email: newUser.email,
      role: newUser.role,
      timestamp: new Date().toISOString()
    });

    return done(null, newUser);
  }));

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, user);
  });
}

// ============================================
// AUTH MIDDLEWARE
// ============================================
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated() && req.user.role !== 'pending') {
    return next();
  }
  if (req.isAuthenticated() && req.user.role === 'pending') {
    return res.status(403).json({ error: 'Access pending approval' });
  }
  res.status(401).json({ error: 'Not authenticated' });
}

function isAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.role === 'admin') {
    return next();
  }
  res.status(403).json({ error: 'Admin access required' });
}

// ============================================
// ORS HELPER FUNCTIONS
// ============================================
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function findNextStop(currentLat, currentLng, stops) {
  const ARRIVAL_THRESHOLD_KM = 5;

  // Simple: First stop in order = start (skip it), find next unvisited
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];

    // Skip first stop (start point - already left from there)
    if (i === 0) continue;

    const distance = haversineDistance(currentLat, currentLng, stop.lat, stop.lng);

    // If far from this stop (>5km), it's your next destination
    if (distance > ARRIVAL_THRESHOLD_KM) {
      return stop;
    }
    // If within 5km, you've arrived - check next stop
  }

  return null; // All stops visited!
}

async function updateLiveRoute(currentLat, currentLng) {
  // Check if admin manually set next stop
  const progress = db.prepare('SELECT next_stop_id FROM live_route_progress WHERE id = 1').get();
  let nextStop = null;

  if (progress && progress.next_stop_id) {
    // Use manually selected next stop
    nextStop = db.prepare('SELECT * FROM stops WHERE id = ?').get(progress.next_stop_id);
    console.log('Using manually selected next stop:', nextStop?.city);
  } else {
    // Auto-detect next stop based on location
    const stops = db.prepare('SELECT * FROM stops ORDER BY order_index').all();
    nextStop = findNextStop(currentLat, currentLng, stops);
    console.log('Auto-detected next stop:', nextStop?.city);
  }

  if (!nextStop) {
    db.prepare('UPDATE live_route_progress SET is_active = 0 WHERE id = 1').run();
    io.emit('live_route_updated', { active: false });
    return;
  }

  const apiKey = process.env.OPENROUTE_API_KEY;
  if (!apiKey) return;

  try {
    const ors = new ORSClient(apiKey);
    const route = await ors.getRoute(currentLat, currentLng, nextStop.lat, nextStop.lng, 'driving-car');

    db.prepare(`
      UPDATE live_route_progress SET
        from_lat = ?, from_lng = ?, to_stop_id = ?,
        geometry = ?, distance_meters = ?, duration_seconds = ?,
        is_active = 1, last_updated = datetime('now')
      WHERE id = 1
    `).run(currentLat, currentLng, nextStop.id, JSON.stringify(route.geometry), route.distance, route.duration);

    io.emit('live_route_updated', {
      active: true,
      to_stop_id: nextStop.id,
      to_city: nextStop.city,
      distance_meters: route.distance,
      duration_seconds: route.duration
    });
  } catch (err) {
    console.error('Failed to calculate live route:', err);
  }
}

function invalidateRoutesForStop(stopId) {
  db.prepare('DELETE FROM route_segments WHERE from_stop_id = ? OR to_stop_id = ?').run(stopId, stopId);
  io.emit('routes_invalidated');
}

// ============================================
// FILE UPLOAD SETUP
// ============================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB for videos
  fileFilter: (req, file, cb) => {
    // Allow images and videos
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi|webm|mkv/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = /^(image|video)\//.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only images and videos are allowed'));
  }
});

// ============================================
// AUTH ROUTES
// ============================================
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  (req, res) => {
    res.redirect('/');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/login.html');
  });
});

app.get('/auth/me', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        picture: req.user.picture,
        role: req.user.role
      }
    });
  } else {
    res.json({ user: null });
  }
});

// Diagnostic endpoint to check ffmpeg availability
app.get('/api/diagnostics', isAdmin, (req, res) => {
  const { execSync } = require('child_process');
  const diagnostics = {
    nodeVersion: process.version,
    platform: process.platform,
    dataDir: DATA_DIR,
    uploadsDir: UPLOADS_DIR,
    ffmpegPath: ffmpegPath,
    ffmpegAvailable: false,
    ffmpegVersion: null
  };

  try {
    diagnostics.ffmpegVersion = execSync('ffmpeg -version').toString().split('\n')[0];
    diagnostics.ffmpegAvailable = true;
  } catch (err) {
    diagnostics.ffmpegError = err.message;
  }

  res.json(diagnostics);
});

// ============================================
// API ROUTES - STOPS
// ============================================
app.get('/api/stops', isAuthenticated, (req, res) => {
  const stops = db.prepare('SELECT * FROM stops ORDER BY order_index').all();
  res.json(stops);
});

app.post('/api/stops', isAdmin, (req, res) => {
  const { city, lat, lng, date, nights, type, note, is_start, is_end, fog_zone, insert_after_id } = req.body;

  let order_index;

  if (insert_after_id) {
    // Insert after specific stop
    const afterStop = db.prepare('SELECT order_index FROM stops WHERE id = ?').get(insert_after_id);
    if (!afterStop) {
      return res.status(400).json({ error: 'Invalid insert_after_id' });
    }
    order_index = afterStop.order_index + 0.5;

    // Shift all stops after this position
    db.prepare('UPDATE stops SET order_index = order_index + 1 WHERE order_index > ?').run(afterStop.order_index);
    order_index = afterStop.order_index + 1;
  } else {
    // Append to end
    const maxOrder = db.prepare('SELECT MAX(order_index) as max FROM stops').get();
    order_index = (maxOrder.max || 0) + 1;
  }

  const result = db.prepare(`
    INSERT INTO stops (city, lat, lng, date, nights, type, note, is_start, is_end, fog_zone, order_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(city, lat, lng, date, nights || 0, type || 'normal', note || '', is_start ? 1 : 0, is_end ? 1 : 0, fog_zone ? 1 : 0, order_index);

  const newStop = db.prepare('SELECT * FROM stops WHERE id = ?').get(result.lastInsertRowid);
  io.emit('stops_updated');
  res.json(newStop);
});

app.put('/api/stops/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const { city, lat, lng, date, nights, type, note, is_start, is_end, fog_zone, order_index } = req.body;

  // Check if coordinates changed
  const oldStop = db.prepare('SELECT * FROM stops WHERE id = ?').get(id);
  const coordsChanged = oldStop && (oldStop.lat !== lat || oldStop.lng !== lng);

  db.prepare(`
    UPDATE stops SET city=?, lat=?, lng=?, date=?, nights=?, type=?, note=?, is_start=?, is_end=?, fog_zone=?, order_index=?
    WHERE id=?
  `).run(city, lat, lng, date, nights || 0, type || 'normal', note || '', is_start ? 1 : 0, is_end ? 1 : 0, fog_zone ? 1 : 0, order_index || 0, id);

  if (coordsChanged) {
    invalidateRoutesForStop(id);
  }

  const updatedStop = db.prepare('SELECT * FROM stops WHERE id = ?').get(id);
  io.emit('stops_updated');
  res.json(updatedStop);
});

app.delete('/api/stops/:id', isAdmin, (req, res) => {
  const { id} = req.params;
  invalidateRoutesForStop(id);
  db.prepare('DELETE FROM stops WHERE id = ?').run(id);
  io.emit('stops_updated');
  res.json({ success: true });
});

app.put('/api/stops/:id/complete', isAdmin, (req, res) => {
  const { id } = req.params;
  const { completed } = req.body;

  db.prepare('UPDATE stops SET completed = ? WHERE id = ?').run(completed ? 1 : 0, id);

  const updatedStop = db.prepare('SELECT * FROM stops WHERE id = ?').get(id);
  io.emit('stops_updated');
  res.json(updatedStop);
});

app.put('/api/stops/reorder', isAdmin, (req, res) => {
  const { orderedIds } = req.body;
  const updateOrder = db.prepare('UPDATE stops SET order_index = ? WHERE id = ?');

  orderedIds.forEach((id, index) => {
    updateOrder.run(index, id);
  });

  // Clear all routes since order affects route sequence
  db.prepare('DELETE FROM route_segments').run();
  io.emit('routes_invalidated');
  io.emit('stops_updated');
  res.json({ success: true });
});

// ============================================
// API ROUTES - LIVE LOCATION
// ============================================
app.get('/api/location', isAuthenticated, (req, res) => {
  const location = db.prepare('SELECT * FROM live_location WHERE id = 1').get();
  res.json(location);
});

app.post('/api/location', isAdmin, async (req, res) => {
  const { lat, lng, accuracy, speed, heading } = req.body;

  db.prepare(`
    UPDATE live_location SET lat=?, lng=?, accuracy=?, speed=?, heading=?, updated_at=datetime('now')
    WHERE id=1
  `).run(lat, lng, accuracy || null, speed || null, heading || null);

  // Calculate live route to next destination
  await updateLiveRoute(lat, lng);

  io.emit('location_updated', { lat, lng, accuracy, speed, heading, updated_at: new Date().toISOString() });
  res.json({ success: true });
});

// Stop live location and route tracking
app.post('/api/location/stop', isAdmin, (req, res) => {
  // Deactivate live route
  db.prepare('UPDATE live_route_progress SET is_active = 0 WHERE id = 1').run();

  // Broadcast that live route is now inactive
  io.emit('live_route_updated', { active: false });

  res.json({ success: true });
});

// Set next stop manually
app.post('/api/location/set-next-stop', isAdmin, async (req, res) => {
  const { stop_id } = req.body;

  if (!stop_id) {
    return res.status(400).json({ error: 'stop_id is required' });
  }

  // Verify stop exists
  const stop = db.prepare('SELECT * FROM stops WHERE id = ?').get(stop_id);
  if (!stop) {
    return res.status(404).json({ error: 'Stop not found' });
  }

  // Update next_stop_id and clear resting status (setting next stop = resuming travel)
  db.prepare(`
    UPDATE live_route_progress
    SET next_stop_id = ?, resting_for_night = 0, resting_location = NULL
    WHERE id = 1
  `).run(stop_id);

  // Get current location and recalculate route
  const location = db.prepare('SELECT * FROM live_location WHERE id = 1').get();
  if (location && location.lat && location.lng) {
    await updateLiveRoute(location.lat, location.lng);
  }

  // Notify clients that resting has ended and route is active
  io.emit('resting_status_changed', { resting: false });
  io.emit('live_route_updated', { next_stop: stop });
  res.json({ success: true, next_stop: stop });
});

// Start resting for the night
app.post('/api/location/rest', isAdmin, (req, res) => {
  const { location_name } = req.body;

  // Set resting status
  db.prepare('UPDATE live_route_progress SET resting_for_night = 1, resting_location = ?, is_active = 0 WHERE id = 1')
    .run(location_name || 'Unknown Location');

  io.emit('resting_status_changed', { resting: true, location: location_name });
  res.json({ success: true });
});

// Resume travel (stop resting)
app.post('/api/location/resume', isAdmin, async (req, res) => {
  // Clear resting status
  db.prepare('UPDATE live_route_progress SET resting_for_night = 0, resting_location = NULL WHERE id = 1').run();

  // Recalculate route if location is available
  const location = db.prepare('SELECT * FROM live_location WHERE id = 1').get();
  if (location && location.lat && location.lng) {
    await updateLiveRoute(location.lat, location.lng);
  }

  io.emit('resting_status_changed', { resting: false });
  res.json({ success: true });
});

// Get resting status
app.get('/api/location/resting', isAuthenticated, (req, res) => {
  const progress = db.prepare('SELECT resting_for_night, resting_location FROM live_route_progress WHERE id = 1').get();
  res.json({
    resting: progress?.resting_for_night === 1,
    location: progress?.resting_location
  });
});

// ============================================
// API ROUTES - PHOTOS
// ============================================
app.get('/api/photos', isAuthenticated, (req, res) => {
  const photos = db.prepare('SELECT * FROM photos ORDER BY uploaded_at DESC').all();
  res.json(photos);
});

app.post('/api/photos', isAdmin, upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  let { lat, lng, caption, stop_id } = req.body;
  const photoId = uuidv4();
  const inputPath = req.file.path;
  const outputPath = path.join(UPLOADS_DIR, req.file.filename);
  const isVideo = req.file.mimetype.startsWith('video/');

  try {
    console.log('Upload started:', {
      filename: req.file.filename,
      isVideo,
      manualLocation: { lat, lng }
    });

    // Always try to extract GPS from EXIF for images (prioritize embedded location)
    if (!isVideo) {
      try {
        console.log('Attempting EXIF GPS extraction...');
        const exifData = await exifr.parse(inputPath, { gps: true });
        console.log('EXIF data:', exifData ? {
          hasLatitude: !!exifData.latitude,
          hasLongitude: !!exifData.longitude,
          latitude: exifData.latitude,
          longitude: exifData.longitude
        } : 'No EXIF data found');

        if (exifData && exifData.latitude && exifData.longitude) {
          // Prioritize EXIF GPS over manual fields
          lat = exifData.latitude;
          lng = exifData.longitude;
          console.log('✓ Using GPS from EXIF:', { lat, lng });
        } else if (lat && lng) {
          console.log('✓ Using manual GPS location:', { lat, lng });
        } else {
          console.log('⚠ No GPS location available (neither EXIF nor manual)');
        }
      } catch (exifError) {
        console.log('EXIF extraction error:', exifError.message);
        if (lat && lng) {
          console.log('✓ Falling back to manual GPS location:', { lat, lng });
        } else {
          console.log('⚠ No GPS location available');
        }
      }
    }

    if (isVideo) {
      // Compress video (WhatsApp style: 720p, lower bitrate)
      console.log('Starting video compression for:', req.file.filename);
      try {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .outputOptions([
              '-c:v libx264',           // H.264 codec
              '-preset faster',         // Faster encoding
              '-crf 26',                // Quality (26 = good quality, better than 28)
              '-maxrate 2M',            // Max bitrate for consistent streaming
              '-bufsize 4M',            // Buffer size
              '-vf scale=-2:720',       // Scale to 720p height, maintain aspect ratio
              '-c:a aac',               // AAC audio codec
              '-b:a 96k',               // Audio bitrate (reduced from 128k)
              '-movflags +faststart',   // Enable fast start for web playback
              '-pix_fmt yuv420p'        // Ensure compatibility
            ])
            .output(outputPath + '.tmp')
            .on('start', (cmd) => {
              console.log('FFmpeg command:', cmd);
            })
            .on('progress', (progress) => {
              console.log('Processing: ' + progress.percent + '% done');
            })
            .on('end', () => {
              console.log('Video compression completed');
              // Replace original with compressed version
              fs.unlinkSync(inputPath);
              fs.renameSync(outputPath + '.tmp', outputPath);
              resolve();
            })
            .on('error', (err) => {
              console.error('Video compression error:', err.message);
              reject(err);
            })
            .run();
        });
      } catch (compressionError) {
        console.error('Video compression failed, saving original:', compressionError.message);
        // Fallback: Keep original video file if compression fails
        // The file is already uploaded to inputPath (which equals outputPath)
        // So we don't need to do anything - just continue
      }
    } else {
      // Compress and resize image (WhatsApp HD style)
      await sharp(inputPath)
        .rotate() // Auto-rotate based on EXIF orientation (fixes iPhone edited photos)
        .resize(1920, 1920, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({
          quality: 85,
          progressive: true
        })
        .toFile(outputPath + '.tmp');

      // Replace original with compressed version
      fs.unlinkSync(inputPath);
      fs.renameSync(outputPath + '.tmp', outputPath);
    }

    // Auto-assign story_order (max + 1)
    const maxOrder = db.prepare('SELECT MAX(story_order) as max FROM photos WHERE include_in_story = 1').get();
    const storyOrder = (maxOrder.max || 0) + 1;

    // Save to database
    db.prepare(`
      INSERT INTO photos (id, filename, original_name, lat, lng, caption, stop_id, story_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(photoId, req.file.filename, req.file.originalname, lat || null, lng || null, caption || '', stop_id || null, storyOrder);

    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(photoId);

    console.log(`${isVideo ? 'Video' : 'Photo'} saved successfully:`, photo.filename);

    // Emit events
    io.emit('photo_added', photo);
    io.emit('photo_uploaded_notification', {
      caption: photo.caption || (isVideo ? 'New video uploaded' : 'New photo uploaded'),
      filename: photo.filename,
      timestamp: new Date().toISOString()
    });

    res.json(photo);
  } catch (err) {
    console.error('Media processing error:', err);

    // Auto-assign story_order (max + 1)
    const maxOrder = db.prepare('SELECT MAX(story_order) as max FROM photos WHERE include_in_story = 1').get();
    const storyOrder = (maxOrder.max || 0) + 1;

    // If processing fails, save the original file
    db.prepare(`
      INSERT INTO photos (id, filename, original_name, lat, lng, caption, stop_id, story_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(photoId, req.file.filename, req.file.originalname, lat || null, lng || null, caption || '', stop_id || null, storyOrder);

    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(photoId);

    io.emit('photo_added', photo);
    io.emit('photo_uploaded_notification', {
      caption: photo.caption || 'New media uploaded',
      filename: photo.filename,
      timestamp: new Date().toISOString()
    });

    res.json(photo);
  }
});

app.delete('/api/photos/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  
  if (photo) {
    // Delete file
    const filePath = path.join(UPLOADS_DIR, photo.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    
    db.prepare('DELETE FROM photos WHERE id = ?').run(id);
    io.emit('photo_deleted', id);
  }
  
  res.json({ success: true });
});

// ============================================
// API ROUTES - STORY
// ============================================

// Get story items (photos + text slides) ordered by admin-specified order
app.get('/api/story', isAuthenticated, (req, res) => {
  // Get all photos included in story
  const photos = db.prepare(`
    SELECT p.*
    FROM photos p
    WHERE p.include_in_story = 1
    ORDER BY p.story_order ASC NULLS LAST, p.uploaded_at ASC
  `).all();

  // Get all text slides
  const textSlides = db.prepare(`
    SELECT t.*
    FROM story_text_slides t
    ORDER BY t.story_order ASC NULLS LAST, t.created_at ASC
  `).all();

  // Combine and sort by story_order
  const storyItems = [
    ...photos.map(p => ({ ...p, type: 'media' })),
    ...textSlides.map(t => ({ ...t, type: 'text' }))
  ].sort((a, b) => {
    // Sort by story_order (nulls last), then by creation time
    const aOrder = a.story_order ?? 999999;
    const bOrder = b.story_order ?? 999999;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    const aTime = a.uploaded_at || a.created_at;
    const bTime = b.uploaded_at || b.created_at;
    return new Date(aTime) - new Date(bTime);
  });

  res.json(storyItems);
});

// Toggle photo inclusion in story
app.put('/api/photos/:id/story', isAdmin, (req, res) => {
  const { id } = req.params;
  const { include_in_story } = req.body;

  db.prepare('UPDATE photos SET include_in_story = ? WHERE id = ?').run(include_in_story ? 1 : 0, id);

  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  io.emit('story_updated');
  res.json(photo);
});

// Add text slide to story
app.post('/api/story/text-slide', isAdmin, (req, res) => {
  const { text_content, stop_id, position_after_photo_id } = req.body;

  if (!text_content) {
    return res.status(400).json({ error: 'text_content is required' });
  }

  const result = db.prepare(`
    INSERT INTO story_text_slides (text_content, stop_id, position_after_photo_id)
    VALUES (?, ?, ?)
  `).run(text_content, stop_id || null, position_after_photo_id || null);

  const slide = db.prepare('SELECT * FROM story_text_slides WHERE id = ?').get(result.lastInsertRowid);
  io.emit('story_updated');
  res.json(slide);
});

// Update text slide
app.put('/api/story/text-slide/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const { text_content, stop_id } = req.body;

  db.prepare('UPDATE story_text_slides SET text_content = ?, stop_id = ? WHERE id = ?')
    .run(text_content, stop_id || null, id);

  const slide = db.prepare('SELECT * FROM story_text_slides WHERE id = ?').get(id);
  io.emit('story_updated');
  res.json(slide);
});

// Delete text slide
app.delete('/api/story/text-slide/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM story_text_slides WHERE id = ?').run(id);
  io.emit('story_updated');
  res.json({ success: true });
});

// Reorder story items
app.post('/api/story/reorder', isAdmin, (req, res) => {
  const { items } = req.body; // Array of { id, type, order }

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'items array required' });
  }

  try {
    items.forEach(item => {
      if (item.type === 'media') {
        db.prepare('UPDATE photos SET story_order = ? WHERE id = ?').run(item.order, item.id);
      } else if (item.type === 'text') {
        db.prepare('UPDATE story_text_slides SET story_order = ? WHERE id = ?').run(item.order, item.id);
      }
    });

    io.emit('story_updated');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to reorder story:', err);
    res.status(500).json({ error: 'Failed to reorder story' });
  }
});

// ============================================
// API ROUTES - USERS (Admin only)
// ============================================
app.get('/api/users', isAdmin, (req, res) => {
  const users = db.prepare('SELECT id, email, name, picture, role, created_at FROM users').all();

  // Enhance with analytics data
  const usersWithAnalytics = users.map(user => {
    // Check if user is currently online
    const onlineCheck = db.prepare(`
      SELECT COUNT(*) as count FROM user_analytics
      WHERE user_id = ? AND is_online = 1
    `).get(user.id);
    const isOnline = onlineCheck.count > 0;

    // Count today's page opens
    const todayCount = db.prepare(`
      SELECT COUNT(*) as count FROM user_analytics
      WHERE user_id = ?
        AND DATE(connected_at) = DATE('now')
    `).get(user.id);

    // Get last activity
    const lastActivity = db.prepare(`
      SELECT MAX(connected_at) as last_active FROM user_analytics
      WHERE user_id = ?
    `).get(user.id);

    return {
      ...user,
      is_online: isOnline,
      today_views: todayCount.count,
      last_active: lastActivity?.last_active
    };
  });

  res.json(usersWithAnalytics);
});

app.put('/api/users/:id/role', isAdmin, (req, res) => {
  const { id } = req.params;
  const { role } = req.body;
  
  if (!['viewer', 'pending', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  res.json({ success: true });
});

app.delete('/api/users/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  
  // Prevent self-deletion
  if (req.user.id === id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true });
});

// ============================================
// API ROUTES - DESTINATION INFO
// ============================================
const destinationInfo = {
  "vizag": {
    places: [
      { name: "RK Beach & Kailasagiri", desc: "Sunrise at beach, ropeway to hilltop for panoramic views." },
      { name: "Submarine Museum", desc: "Real submarine museum. Opens 2 PM." },
      { name: "Araku Valley", desc: "3-hour drive through Eastern Ghats. Coffee plantations." }
    ],
    food: [
      { name: "Muri Mixture", desc: "Iconic street snack - puffed rice with spicy chutneys." },
      { name: "Punugulu", desc: "Deep-fried rice batter balls. Perfect evening snack." }
    ],
    foodTags: ["Muri Mixture", "Punugulu", "Seafood", "Gongura"]
  },
  "puri": {
    places: [
      { name: "Jagannath Temple", desc: "One of the Char Dhams. Non-Hindus cannot enter main shrine." },
      { name: "Konark Sun Temple", desc: "UNESCO site 35 km away. Giant chariot architecture." }
    ],
    food: [
      { name: "Mahaprasad", desc: "Sacred temple food - 56 items cooked without onion/garlic." },
      { name: "Chenna Poda", desc: "Caramelized cottage cheese dessert." }
    ],
    foodTags: ["Mahaprasad", "Dalma", "Chenna Poda", "Rasagola"]
  },
  "kolkata": {
    places: [
      { name: "Victoria Memorial", desc: "Iconic white marble monument. Gardens open at sunrise." },
      { name: "Howrah Bridge", desc: "Walk across at dawn, explore Mullick Ghat flower market." }
    ],
    food: [
      { name: "Kathi Roll", desc: "Kolkata's gift to street food - kebabs in paratha." },
      { name: "Phuchka", desc: "Bengal's tangier version of pani puri." }
    ],
    foodTags: ["Kathi Roll", "Phuchka", "Rosogolla", "Mishti Doi"]
  },
  "siliguri": {
    places: [
      { name: "Mahananda Wildlife Sanctuary", desc: "Morning safari - elephants, deer, birds." },
      { name: "Hong Kong Market", desc: "Electronics and imported goods at bargain prices." }
    ],
    food: [
      { name: "Momos", desc: "Tibetan dumplings everywhere! Steamed or fried." },
      { name: "Thukpa", desc: "Hot noodle soup perfect for cooler weather." }
    ],
    foodTags: ["Momos", "Thukpa", "Darjeeling Tea", "Sel Roti"]
  },
  "phuentsholing": {
    places: [
      { name: "Bhutan Gate", desc: "Iconic colorful entry gate to Bhutan." },
      { name: "Zangto Pelri Lhakhang", desc: "Beautiful temple - peaceful atmosphere." }
    ],
    food: [
      { name: "Ema Datshi", desc: "National dish - spicy chilies in cheese. Very hot!" },
      { name: "Red Rice", desc: "Nutty Bhutanese rice with meals." }
    ],
    foodTags: ["Ema Datshi", "Momos", "Red Rice", "Suja"]
  },
  "thimphu": {
    places: [
      { name: "Buddha Dordenma", desc: "Giant 169ft Buddha statue overlooking valley." },
      { name: "Tashichho Dzong", desc: "Seat of government. Open after 5 PM weekdays." }
    ],
    food: [
      { name: "Jasha Maru", desc: "Spicy minced chicken stew." },
      { name: "Phaksha Paa", desc: "Pork with red chilies and radishes." }
    ],
    foodTags: ["Ema Datshi", "Jasha Maru", "Hoentay", "Ara"]
  },
  "paro": {
    places: [
      { name: "Tiger's Nest (Taktsang)", desc: "Iconic cliff monastery. 4-5 hour hike. Start by 7 AM!" },
      { name: "Paro Dzong", desc: "Fortress monastery from 'Little Buddha' film." }
    ],
    food: [
      { name: "Shakam Paa", desc: "Dried beef with chilies - mountain cuisine." },
      { name: "Zow Shungo", desc: "Mixed vegetables with cheese sauce." }
    ],
    foodTags: ["Shakam Paa", "Ema Datshi", "Suja", "Local Ara"]
  },
  "patna": {
    places: [
      { name: "Golghar", desc: "Beehive-shaped granary. 145 steps for city view." },
      { name: "Patna Museum", desc: "Buddha relics and Mauryan artifacts." }
    ],
    food: [
      { name: "Litti Chokha", desc: "Bihari soul food - stuffed wheat balls." },
      { name: "Sattu Paratha", desc: "Protein-rich roasted gram flour bread." }
    ],
    foodTags: ["Litti Chokha", "Sattu", "Thekua", "Khaja"]
  },
  "varanasi": {
    places: [
      { name: "Dashashwamedh Ghat", desc: "Famous Ganga Aarti at 6:30 PM. Arrive early!" },
      { name: "Sunrise Boat Ride", desc: "Dawn boat ride along ghats. 5:30-7 AM." }
    ],
    food: [
      { name: "Kachori Sabzi", desc: "Breakfast champion - crispy kachoris with spicy curry." },
      { name: "Malaiyo", desc: "Winter special saffron milk foam. Dec-Feb mornings only!" }
    ],
    foodTags: ["Kachori", "Malaiyo", "Thandai", "Banarasi Paan"]
  },
  "bhedaghat": {
    places: [
      { name: "Marble Rocks Boat Ride", desc: "30-min ride between 100ft marble cliffs." },
      { name: "Dhuandhar Falls", desc: "Smoky Falls - Narmada plunges 30m creating mist." }
    ],
    food: [
      { name: "Dal Bafla", desc: "MP's dal baati - wheat balls in ghee and dal." },
      { name: "Poha Jalebi", desc: "Classic MP breakfast combo." }
    ],
    foodTags: ["Dal Bafla", "Poha Jalebi", "Bhutte ka Kees"]
  },
  "indore": {
    places: [
      { name: "Sarafa Bazaar", desc: "India's famous food street - opens 8 PM after shops close!" },
      { name: "Chappan Dukan", desc: "56 shops, diverse cuisines. Open all day." }
    ],
    food: [
      { name: "Poha-Jalebi", desc: "Indore's iconic breakfast. Must have!" },
      { name: "Garadu", desc: "Winter special fried yam. Dec-Feb only." }
    ],
    foodTags: ["Poha-Jalebi", "Garadu", "Bhutte ka Kees", "Shikanji"]
  }
};

app.get('/api/destinations/:city', isAuthenticated, (req, res) => {
  const city = req.params.city.toLowerCase();
  const info = destinationInfo[city];
  if (info) {
    res.json(info);
  } else {
    res.status(404).json({ error: 'Destination info not found' });
  }
});

// ============================================
// API ROUTES - ROUTES
// ============================================
app.get('/api/routes', isAuthenticated, (req, res) => {
  const routes = db.prepare(`
    SELECT rs.*, s1.city as from_city, s2.city as to_city,
           s1.order_index as from_order, s2.order_index as to_order
    FROM route_segments rs
    JOIN stops s1 ON rs.from_stop_id = s1.id
    JOIN stops s2 ON rs.to_stop_id = s2.id
    ORDER BY s1.order_index
  `).all();

  res.json(routes.map(r => ({
    ...r,
    geometry: JSON.parse(r.geometry),
    bbox: r.bbox ? JSON.parse(r.bbox) : null
  })));
});

app.get('/api/routes/live', isAuthenticated, (req, res) => {
  const liveRoute = db.prepare(`
    SELECT lr.*, s.city as to_city
    FROM live_route_progress lr
    LEFT JOIN stops s ON lr.to_stop_id = s.id
    WHERE lr.id = 1
  `).get();

  if (!liveRoute || !liveRoute.is_active) {
    return res.json({ active: false });
  }

  res.json({
    active: true,
    from: { lat: liveRoute.from_lat, lng: liveRoute.from_lng },
    to_stop_id: liveRoute.to_stop_id,
    to_city: liveRoute.to_city,
    geometry: JSON.parse(liveRoute.geometry),
    distance_meters: liveRoute.distance_meters,
    duration_seconds: liveRoute.duration_seconds,
    last_updated: liveRoute.last_updated
  });
});

app.post('/api/routes/recalculate', isAdmin, async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTE_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'ORS API key not configured in .env' });
    }

    const ors = new ORSClient(apiKey);
    const stops = db.prepare('SELECT * FROM stops ORDER BY order_index').all();

    let calculated = 0;
    let errors = [];

    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i];
      const to = stops[i + 1];

      try {
        const route = await ors.getRoute(from.lat, from.lng, to.lat, to.lng, 'driving-car');

        db.prepare(`
          INSERT OR REPLACE INTO route_segments
            (from_stop_id, to_stop_id, geometry, distance_meters, duration_seconds, bbox, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(from.id, to.id, JSON.stringify(route.geometry), route.distance, route.duration, JSON.stringify(route.bbox));

        calculated++;
      } catch (err) {
        errors.push(`${from.city} → ${to.city}: ${err.message}`);
      }
    }

    io.emit('routes_updated');
    res.json({ success: true, calculated, total: stops.length - 1, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SOCKET.IO
// ============================================
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Track user analytics if authenticated
  const user = socket.request.session?.passport?.user;
  if (user) {
    const userId = user.id || user;
    const sessionId = socket.id;

    try {
      // Insert new session record
      db.prepare(`
        INSERT INTO user_analytics (user_id, session_id, connected_at, is_online)
        VALUES (?, ?, datetime('now'), 1)
      `).run(userId, sessionId);

      console.log(`User ${userId} connected (session: ${sessionId})`);

      // Broadcast analytics update to admins
      io.emit('analytics_updated');
    } catch (err) {
      console.error('Failed to track user connection:', err);
    }
  }

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    // Mark user as offline
    if (user) {
      try {
        db.prepare(`
          UPDATE user_analytics
          SET disconnected_at = datetime('now'), is_online = 0
          WHERE session_id = ? AND is_online = 1
        `).run(socket.id);

        console.log(`User ${user.id || user} disconnected (session: ${socket.id})`);

        // Broadcast analytics update to admins
        io.emit('analytics_updated');
      } catch (err) {
        console.error('Failed to track user disconnection:', err);
      }
    }
  });
});

// ============================================
// SERVE FRONTEND
// ============================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ============================================
// START SERVER
// ============================================
httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║              🏍️ Road Trip Tracker Server 🗺️                 ║
╠════════════════════════════════════════════════════════════╣
║  Server running at: ${BASE_URL.padEnd(36)} ║
║  Admin panel: ${(BASE_URL + '/admin').padEnd(42)} ║
╠════════════════════════════════════════════════════════════╣
║  ${process.env.GOOGLE_CLIENT_ID ? '✅ Google OAuth configured' : '⚠️  Google OAuth NOT configured (check .env)'}                          ║
╚════════════════════════════════════════════════════════════╝
  `);
});

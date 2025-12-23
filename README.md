# 🏍️ Road Trip Tracker

A real-time road trip tracking application with live location sharing, photo uploads, and multi-user access control.

## ✨ Features

- **📍 Live Location Sharing**: Share your real-time location with approved viewers
- **🗺️ Interactive Map**: Visualize your entire journey with route segments
- **📷 Photo Gallery**: Upload photos with location tags and captions
- **👥 User Management**: Google OAuth authentication with admin approval system
- **🔄 Real-time Updates**: Socket.IO for instant updates across all connected users
- **📱 Mobile Friendly**: Responsive design works on all devices

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Google Cloud Console account (for OAuth)

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd roadtrip-tracker
npm install
```

### 2. Configure Google OAuth

1. Go to [Google Cloud Console](https://console.developers.google.com/)
2. Create a new project or select existing
3. Enable **Google+ API** and **Google Identity** services
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Configure the consent screen:
   - Add your email as test user (while in testing mode)
   - Set app name and scopes (email, profile)
6. Create OAuth Client ID:
   - Application type: **Web application**
   - Authorized redirect URIs: 
     - `http://localhost:3000/auth/google/callback` (for local dev)
     - `https://your-domain.com/auth/google/callback` (for production)
7. Copy the Client ID and Client Secret

### 3. Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
PORT=3000
BASE_URL=http://localhost:3000
SESSION_SECRET=generate-a-long-random-string-here
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

### 4. Run Locally

```bash
npm start
```

Open http://localhost:3000

**First user to login becomes the admin!**

---

## 🌐 Deployment Options

### Option 1: Railway (Recommended - Free Tier)

1. Push code to GitHub
2. Go to [Railway.app](https://railway.app)
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repo
5. Add environment variables in Railway dashboard
6. Railway will auto-deploy and give you a URL
7. Update `BASE_URL` in env vars to the Railway URL
8. Add the Railway URL to Google OAuth redirect URIs

### Option 2: Render (Free Tier)

1. Push code to GitHub
2. Go to [Render.com](https://render.com)
3. New → Web Service → Connect your repo
4. Settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Add environment variables
6. Deploy!

### Option 3: AWS EC2 (Free Tier)

```bash
# On EC2 instance (Amazon Linux 2 / Ubuntu)

# Install Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs  # or apt-get for Ubuntu

# Clone and setup
git clone <your-repo>
cd roadtrip-tracker
npm install

# Create .env file
nano .env

# Install PM2 for production
sudo npm install -g pm2

# Start with PM2
pm2 start server.js --name roadtrip
pm2 startup
pm2 save

# Setup nginx (optional, for SSL)
sudo yum install nginx
# Configure nginx as reverse proxy
```

### Option 4: Local Server with Ngrok (Quick Sharing)

```bash
# Terminal 1: Start server
npm start

# Terminal 2: Expose with ngrok
npx ngrok http 3000
```

Use the ngrok URL for sharing (update Google OAuth too)

### Option 5: Docker

```dockerfile
# Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t roadtrip-tracker .
docker run -p 3000:3000 --env-file .env roadtrip-tracker
```

---

## 👥 User Roles

| Role | Permissions |
|------|------------|
| **Admin** | Full access: manage stops, users, photos, location |
| **Viewer** | View-only: see trip, photos, live location |
| **Pending** | Waiting for admin approval |

The **first user** to login automatically becomes admin.

---

## 📁 Project Structure

```
roadtrip-tracker/
├── server.js          # Main server file
├── package.json       # Dependencies
├── .env              # Environment variables (create from .env.example)
├── data/             # SQLite database (auto-created)
│   └── roadtrip.db
├── uploads/          # Photo uploads (auto-created)
└── public/           # Frontend files
    ├── index.html    # Main trip viewer
    └── admin.html    # Admin panel
```

---

## 🔧 API Endpoints

### Authentication
- `GET /auth/google` - Start Google OAuth
- `GET /auth/google/callback` - OAuth callback
- `GET /auth/logout` - Logout
- `GET /auth/me` - Get current user

### Stops
- `GET /api/stops` - List all stops
- `POST /api/stops` - Create stop (admin)
- `PUT /api/stops/:id` - Update stop (admin)
- `DELETE /api/stops/:id` - Delete stop (admin)

### Photos
- `GET /api/photos` - List all photos
- `POST /api/photos` - Upload photo (admin)
- `DELETE /api/photos/:id` - Delete photo (admin)

### Location
- `GET /api/location` - Get live location
- `POST /api/location` - Update location (admin)

### Users
- `GET /api/users` - List users (admin)
- `PUT /api/users/:id/role` - Change role (admin)
- `DELETE /api/users/:id` - Remove user (admin)

---

## 🔒 Security Notes

1. **Session Secret**: Use a long, random string in production
2. **HTTPS**: Always use HTTPS in production (Railway/Render handle this)
3. **OAuth**: Keep your Google Client Secret private
4. **Database**: SQLite file is stored locally - backup regularly

---

## 📱 Mobile Location Sharing

To share location from mobile:
1. Open admin panel on your phone's browser
2. Go to "Live Location" tab
3. Click "Start Sharing Location"
4. Keep the browser tab open (or use "Add to Home Screen" for PWA-like experience)

---

## 🐛 Troubleshooting

### "Google OAuth Error"
- Verify redirect URI matches exactly (including trailing slashes)
- Check if your email is added as test user in Google Console

### "Database Locked"
- Only run one instance of the server at a time
- The SQLite database is single-writer

### "Location Not Updating"
- Ensure HTTPS is used (required for Geolocation API)
- Check browser location permissions

---

## 📄 License

MIT License - Feel free to use and modify!

---

Built with ❤️ for epic road trips!

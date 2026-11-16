# Master SPK Creator

The app stores SPK records in Cloud Firestore and drawing files in Firebase Storage through a private Node.js backend. Firebase Admin credentials stay on the server and are never sent to the browser.

## Local setup

1. Install Node.js 20.6 or newer.
2. In Firebase Console, enable Cloud Firestore and Cloud Storage for the project.
3. Create a dedicated service account with the minimum required Firestore and Storage permissions. Download its JSON key and save it outside the repository when possible.
4. Copy `.env.example` to `.env`. Set `GOOGLE_APPLICATION_CREDENTIALS` to the service-account JSON file path. Do not commit `.env` or the service-account key.
5. Install dependencies and start the app:

   ```powershell
   npm install
   npm start
   ```

6. Open `http://localhost:3000`. Do not open `index.html` directly as a `file://` URL; database requests need the backend.

## Private office/VPN access

The server binds to `127.0.0.1` by default. To make it available to other users, host it on a company-controlled machine behind the VPN/firewall, set `HOST=0.0.0.0`, and list the trusted client IP addresses in `ALLOWED_CLIENT_IPS` (comma-separated). The server refuses to bind to a non-local address without this allowlist. Also enforce the same restriction at the network firewall; do not expose this backend directly to the public internet.

The backend uses Firebase Admin, which bypasses Firestore security rules. Keep the service-account key private and rely on the private network and IP restrictions for access control. Never add public Firestore read/write rules for this app.

## Existing browser data

Records previously stored in this browser's localStorage are not uploaded automatically. Export or review them before deciding whether to migrate them to Firestore.

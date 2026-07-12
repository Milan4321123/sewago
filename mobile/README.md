# SewaGo Mobile Wrapper

This Expo app opens the deployed SewaGo web app in a native WebView. It is the
fastest path to testing SewaGo in Expo Go without rewriting the customer,
driver, partner and admin apps in React Native.

## Run In Expo Go

```bash
cd mobile
npm install
cp .env.example .env
# edit EXPO_PUBLIC_SEWAGO_URL to your deployed backend URL
npm start
```

Scan the QR code with Expo Go.

For local testing on a real phone, `http://localhost:4000` usually will not work
because it points at the phone. Use your computer's LAN IP, for example:

```text
EXPO_PUBLIC_SEWAGO_URL=http://192.168.1.20:4000
```

The WebView enables geolocation so the Driver app's live GPS flow can work
inside Expo Go.

## Build A Downloadable Android APK

After the backend is deployed online, set:

```text
EXPO_PUBLIC_SEWAGO_URL=https://your-deployed-sewago-domain.example
```

Then run:

```bash
npm run build:android:apk
```

Expo/EAS will return a download URL for an APK that Android users can install
directly. You need an Expo account for cloud builds.

## iPhone

For quick iPhone installation, open the deployed `/download` page in Safari and
choose Share, then Add to Home Screen.

For App Store distribution, run:

```bash
npm run build:ios
```

You need an Apple Developer account for iOS builds.

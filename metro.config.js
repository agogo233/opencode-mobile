// Metro bundler config: Expo's defaults, no wrapper (Sentry's Debug ID
// embedding was removed together with the Sentry SDK).
const { getDefaultConfig } = require("expo/metro-config")

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname)

module.exports = config

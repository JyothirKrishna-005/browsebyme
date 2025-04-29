/**
 * Configuration settings for BrowseByMe
 */
require('dotenv').config();

const config = {
  // Server configuration
  server: {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development'
  },
  
  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    fileEnabled: process.env.LOG_TO_FILE === 'true' || true
  },
  
  // Browser configuration
  browser: {
    defaultType: process.env.DEFAULT_BROWSER || 'chromium',
    headless: process.env.HEADLESS === 'true' || false,
    defaultTimeout: parseInt(process.env.BROWSER_TIMEOUT || '30000', 10)
  },
  
  // Security configuration
  security: {
    enableEncryption: process.env.ENABLE_ENCRYPTION === 'true' || false
  }
};

module.exports = config; 
/**
 * BrowseByMe - AI-powered browser automation tool
 */
const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { logger } = require('./utils/logger');
const BrowserController = require('./browser/browserController');
const CommandParser = require('./commands/commandParser');

// Load environment variables
dotenv.config();

// Initialize the application
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize browser controller
const browserController = new BrowserController();
const commandParser = new CommandParser(browserController);

// Routes
app.post('/command', async (req, res) => {
  try {
    const { command } = req.body;
    
    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }
    
    logger.info(`Received command: ${command}`);
    
    const result = await commandParser.parseAndExecute(command);
    res.json({ success: true, result });
  } catch (error) {
    logger.error(`Error processing command: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Serve the HTML interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start the server
app.listen(PORT, () => {
  logger.info(`BrowseByMe server running on port ${PORT}`);
  logger.info(`Visit http://localhost:${PORT} to use the web interface`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  await browserController.closeAll();
  process.exit(0);
}); 
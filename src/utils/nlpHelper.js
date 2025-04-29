/**
 * NLP Helper for BrowseByMe
 * Provides natural language processing functions
 */
const natural = require('natural');
const { logger } = require('./logger');

/**
 * Extract entities from a text command
 * @param {string} text - Text to extract entities from
 * @returns {object} Object containing extracted entities
 */
function extractEntities(text) {
  try {
    logger.info('Extracting entities from text');
    
    // Create tokenizer
    const tokenizer = new natural.WordTokenizer();
    const tokens = tokenizer.tokenize(text.toLowerCase());
    
    // Simple entity extraction
    const entities = {
      dates: extractDates(text),
      times: extractTimes(text),
      numbers: extractNumbers(text),
      locations: extractLocations(text),
      products: extractProducts(text)
    };
    
    logger.info(`Extracted ${Object.keys(entities).length} entity types`);
    return entities;
  } catch (error) {
    logger.error(`Entity extraction error: ${error.message}`);
    return {};
  }
}

/**
 * Extract dates from text
 * @param {string} text - Text to extract dates from
 * @returns {Array} Array of extracted dates
 */
function extractDates(text) {
  const dates = [];
  
  // Pattern for dates like "tomorrow", "next Friday", etc.
  const relativeDatePattern = /\b(today|tomorrow|yesterday|next\s+\w+|last\s+\w+)\b/gi;
  const relativeDateMatches = text.match(relativeDatePattern) || [];
  
  // Pattern for dates like MM/DD/YYYY, DD-MM-YYYY, etc.
  const datePattern = /\b(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/g;
  const dateMatches = text.match(datePattern) || [];
  
  return [...relativeDateMatches, ...dateMatches];
}

/**
 * Extract times from text
 * @param {string} text - Text to extract times from
 * @returns {Array} Array of extracted times
 */
function extractTimes(text) {
  // Pattern for times like "7 PM", "3:30", etc.
  const timePattern = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/gi;
  return text.match(timePattern) || [];
}

/**
 * Extract numbers from text
 * @param {string} text - Text to extract numbers from
 * @returns {Array} Array of extracted numbers
 */
function extractNumbers(text) {
  // Pattern for numbers (including ordinals)
  const numberPattern = /\b(\d+(?:st|nd|rd|th)?)\b/g;
  return text.match(numberPattern) || [];
}

/**
 * Extract locations from text
 * @param {string} text - Text to extract locations from
 * @returns {Array} Array of potential locations
 */
function extractLocations(text) {
  // This is a simplified approach that would need to be improved with a proper NER model
  const locationIndicators = ['in', 'at', 'near', 'from', 'to'];
  const tokens = text.split(/\s+/);
  const locations = [];
  
  for (let i = 0; i < tokens.length - 1; i++) {
    if (locationIndicators.includes(tokens[i].toLowerCase())) {
      // Take the next few tokens as potential location
      const potentialLocation = tokens.slice(i + 1, i + 4).join(' ');
      locations.push(potentialLocation);
    }
  }
  
  return locations;
}

/**
 * Extract products from text
 * @param {string} text - Text to extract products from
 * @returns {Array} Array of potential products
 */
function extractProducts(text) {
  // This is a simplified approach that would need to be improved with a proper NER model
  const productIndicators = ['buy', 'purchase', 'get', 'order', 'book', 'tickets', 'for'];
  const tokens = text.split(/\s+/);
  const products = [];
  
  for (let i = 0; i < tokens.length - 1; i++) {
    if (productIndicators.includes(tokens[i].toLowerCase())) {
      // Take the next few tokens as potential product
      const potentialProduct = tokens.slice(i + 1, i + 4).join(' ');
      products.push(potentialProduct);
    }
  }
  
  return products;
}

module.exports = {
  extractEntities
}; 
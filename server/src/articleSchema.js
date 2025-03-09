/**
 * @fileoverview Article Schema Definition
 * @description This file defines the Mongoose schema for article documents in the database.
 * Articles represent user-created content posts in the social media application.
 * 
 * @module ArticleSchema
 * @requires mongoose
 * 
 * @version 1.0.0
 * @author Supwils
 * @copyright Web Social Application
 */

const mongoose = require('mongoose');

/**
 * @typedef {Object} Article
 * @property {number} id - Unique identifier for the article (optional)
 * @property {string} author - Username of the article author
 * @property {string} text - The main content of the article
 * @property {Date} date - Timestamp when the article was created
 * @property {string} img - URL to an image attached to the article (if any)
 * @property {Array} comment - Array of comments associated with this article
 */

/**
 * Article Schema - Defines the structure of article documents in MongoDB
 * 
 * @type {mongoose.Schema}
 */
const articleSchema = new mongoose.Schema({
    /**
     * Unique identifier for the article
     * Note: MongoDB already provides _id, so this may be used for alternative identification
     * @type {Number}
     */
    id: {
        type: Number,
    },

    /**
     * Username of the person who created the article
     * This field is required and links to the user who authored the content
     * @type {String}
     * @required
     */
    author: {
        type: String,
        required: [true, 'author is required']
    },

    /**
     * The main textual content of the article
     * This field is required and contains the actual post content
     * @type {String}
     * @required
     */
    text: {
        type: String,
        required: [true, 'text is required']
    },

    /**
     * The timestamp when the article was created
     * Automatically set to the current date/time if not specified
     * @type {Date}
     */
    date: {
        type: Date,
    },

    /**
     * URL to an image associated with the article
     * Can be empty if no image is attached
     * @type {String}
     * @default ''
     */
    img: {
        type: String,
        default: ''
    },

    /**
     * Array of comments on this article
     * Each comment should follow the comment structure defined elsewhere
     * @type {Array}
     * @default []
     */
    comment: {
        type: Array,
        default: []
    },
}
)

/**
 * Exports the article schema for use in creating the Article model
 * @exports articleSchema
 */
module.exports = articleSchema;
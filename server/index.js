/**
 * @fileoverview Main Server Application Entry Point
 * @description Web Social API server that provides endpoints for social media functionality.
 * The server connects to MongoDB and provides RESTful API endpoints for authentication, 
 * user profiles, article management, and social interactions.
 * 
 * @module server
 * @requires express
 * @requires body-parser
 * @requires cookie-parser
 * @requires cors
 * @requires dotenv
 * @requires ./src/auth
 * @requires ./src/articles
 * @requires ./src/profile
 * @requires ./src/following
 * @requires ./src/index-passport
 * 
 * @version 1.0.0
 * @author Web Social Team
 * @copyright Web Social Application
 */

'use strict';

// Load environment variables from .env file
require('dotenv').config();

// Core dependencies
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require('cors');

// Check for Redis
try
{
     const { isRedisAvailable } = require('./src/redisClient');
     setTimeout(() =>
     {
          if (isRedisAvailable())
          {
               console.log('Redis caching is enabled and connected.');
          } else
          {
               console.log('Redis caching is disabled. Server will run with direct database access.');
               console.log('To enable Redis caching, install Redis and run "npm run start:redis"');
          }
     }, 2000); // Wait for connection attempts to complete
} catch (error)
{
     console.log('Redis module not available. Server will run without caching.');
}

// Application modules
const auth = require('./src/auth');
const article = require('./src/articles');
const profile = require('./src/profile');
const following = require('./src/following');
const passport = require('./src/index-passport');

/**
 * Express application instance
 * @type {object}
 */
const app = express();

/**
 * CORS configuration options
 * Controls which origins can access the API and what methods they can use
 * @type {object}
 */
const corsOptions = {
     origin: process.env.NODE_ENV === 'production'
          ? "YOUR_DOMAIN" //############ADD YOUR DOMAIN HERE!!!!!!############
          : "http://localhost:3000",
     methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
     credentials: true
};

/**
 * Simple health check endpoint that returns a hello world message
 * Used to verify the server is running properly
 * 
 * @function hello
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {object} Simple JSON response with hello world message
 */
const hello = (req, res) => res.send({ hello: 'world' });

// Apply middleware
app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({
     extended: true,
     limit: '10mb'
}));
app.use(cookieParser());

// Define basic routes
app.get('/', hello);
app.get('/health', (req, res) =>
{
     res.status(200).json({
          status: 'ok',
          uptime: process.uptime(),
          timestamp: new Date().toISOString()
     });
});

// Initialize application modules with the Express app
passport(app);
auth(app);
article(app);
profile(app);
following(app);

// Global error handler
app.use((err, req, res, next) =>
{
     console.error('Unhandled error:', err);
     res.status(500).json({
          error: 'Internal Server Error',
          message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
     });
});

// Handle 404 errors for undefined routes
app.use((req, res) =>
{
     res.status(404).json({
          error: 'Not Found',
          message: `Cannot ${req.method} ${req.originalUrl}`
     });
});

// Get the port from the environment, i.e., Heroku sets it
const port = process.env.PORT || 8888;
const server = app.listen(port, () =>
{
     const addr = server.address();
     console.log(`Server listening at http://${addr.address || 'localhost'}:${addr.port}`);
});

/**
 * Gracefully handle process termination
 * Close database connections and server when the process is terminated
 */
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

/**
 * Shut down the server gracefully
 * 
 * @function gracefulShutdown
 */
function gracefulShutdown()
{
     console.log('Shutting down gracefully...');
     server.close(() =>
     {
          console.log('Server closed');
          process.exit(0);
     });

     // Force close if not closed within 10 seconds
     setTimeout(() =>
     {
          console.error('Could not close connections in time, forcefully shutting down');
          process.exit(1);
     }, 10000);
}

/**
 * Export the Express app and server for testing purposes
 * @exports {object}
 */
module.exports = { app, server };
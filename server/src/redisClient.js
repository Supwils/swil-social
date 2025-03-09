/**
 * @fileoverview Redis Client Configuration
 * @description Configures and exports a Redis client for caching throughout the application
 * Redis is optional - if not available, the system will function without caching
 * 
 * @module redisClient
 * @requires redis
 * 
 * @version 1.0.0
 * @author Web Social Team
 * @copyright Web Social Application
 */

'use strict';

require('dotenv').config();

// Flag to track if Redis is enabled and connected
let redisEnabled = true;
let redisConnected = false;
let connectionAttempted = false;
let redisClient = null;
let connectionRetries = 0;
const MAX_RETRIES = 3;

/**
 * Initialize Redis client with retry mechanism
 * @async
 * @returns {Object|null} Redis client or null if Redis is disabled
 */
async function initRedisClient()
{
    // Only attempt to connect once
    if (connectionAttempted && connectionRetries >= MAX_RETRIES)
    {
        return redisClient;
    }

    connectionAttempted = true;

    try
    {
        // Dynamic import for redis to avoid errors if not installed
        const redis = require('redis');

        // Create Redis client with proper configuration
        redisClient = redis.createClient({
            // Use more specific connection settings to avoid security warnings
            socket: {
                host: 'localhost',
                port: 6379,
                connectTimeout: 5000,
                reconnectStrategy: (retries) =>
                {
                    connectionRetries = retries;
                    // Stop trying to reconnect after MAX_RETRIES attempts
                    if (retries >= MAX_RETRIES)
                    {
                        redisEnabled = false;
                        console.log('Redis connection failed after multiple attempts. Caching disabled.');
                        return false; // Stop reconnecting
                    }
                    // Reconnect after a delay (exponential backoff)
                    const delay = Math.min(retries * 50, 1000);
                    console.log(`Retrying Redis connection in ${delay}ms...`);
                    return delay;
                }
            }
        });

        // Set up event handlers
        redisClient.on('connect', () =>
        {
            console.log('Redis client connected successfully');
            redisConnected = true;
        });

        redisClient.on('ready', () =>
        {
            console.log('Redis client ready and accepting commands');
            redisConnected = true;
        });

        redisClient.on('error', (err) =>
        {
            if (redisEnabled)
            {
                console.error('Redis client error:', err.message);

                // After initial connection attempts, if we get an error, disable Redis
                if (connectionAttempted && !redisConnected && connectionRetries >= MAX_RETRIES)
                {
                    redisEnabled = false;
                    console.log('Redis caching disabled due to connection issues');
                }
            }
        });

        // Connect to Redis with timeout
        await redisClient.connect().catch(err =>
        {
            throw new Error(`Redis connection error: ${err.message}`);
        });

        redisConnected = true;
        console.log('Successfully connected to Redis server');
        return redisClient;
    } catch (error)
    {
        console.error('Failed to initialize Redis client:', error.message);
        if (connectionRetries < MAX_RETRIES)
        {
            connectionRetries++;
            console.log(`Retrying Redis connection (${connectionRetries}/${MAX_RETRIES})...`);
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
            return initRedisClient();
        } else
        {
            redisEnabled = false;
            console.log('Running without Redis caching');
            return null;
        }
    }
}

// Initialize Redis client on module load with delay to ensure server is up
setTimeout(() =>
{
    initRedisClient().catch(() =>
    {
        redisEnabled = false;
        console.log('Redis initialization failed. Running without caching.');
    });
}, 1000);

/**
 * Get data from Redis cache
 * 
 * @async
 * @function getCache
 * @param {string} key - Cache key to retrieve
 * @returns {Promise<Object|null>} - The cached data or null if not found or Redis is disabled
 */
async function getCache(key)
{
    if (!redisEnabled || !redisConnected) return null;

    try
    {
        const cachedData = await redisClient.get(key);
        return cachedData ? JSON.parse(cachedData) : null;
    } catch (error)
    {
        console.error('Redis getCache error:', error.message);
        return null;
    }
}

/**
 * Store data in Redis cache
 * 
 * @async
 * @function setCache
 * @param {string} key - Cache key
 * @param {Object} data - Data to cache
 * @param {number} [expireTime=3600] - Cache expiration time in seconds (default: 1 hour)
 * @returns {Promise<boolean>} - Success indicator
 */
async function setCache(key, data, expireTime = 3600)
{
    if (!redisEnabled || !redisConnected) return false;

    try
    {
        await redisClient.setEx(key, expireTime, JSON.stringify(data));
        return true;
    } catch (error)
    {
        console.error('Redis setCache error:', error.message);
        return false;
    }
}

/**
 * Delete a specific cache entry
 * 
 * @async
 * @function deleteCache
 * @param {string} key - Cache key to delete
 * @returns {Promise<boolean>} - Success indicator
 */
async function deleteCache(key)
{
    if (!redisEnabled || !redisConnected) return false;

    try
    {
        await redisClient.del(key);
        return true;
    } catch (error)
    {
        console.error('Redis deleteCache error:', error.message);
        return false;
    }
}

/**
 * Delete all cache entries matching a pattern
 * 
 * @async
 * @function invalidateCachePattern
 * @param {string} pattern - Pattern to match keys (e.g., "articles:*")
 * @returns {Promise<boolean>} - Success indicator
 */
async function invalidateCachePattern(pattern)
{
    if (!redisEnabled || !redisConnected) return false;

    try
    {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0)
        {
            await redisClient.del(keys);
        }
        return true;
    } catch (error)
    {
        console.error('Redis invalidateCachePattern error:', error.message);
        return false;
    }
}

/**
 * Check if Redis is currently enabled and connected
 * @function isRedisAvailable
 * @returns {boolean} Whether Redis is available for use
 */
function isRedisAvailable()
{
    return redisEnabled && redisConnected;
}

module.exports = {
    getCache,
    setCache,
    deleteCache,
    invalidateCachePattern,
    isRedisAvailable
}; 
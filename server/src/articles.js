require('dotenv').config();

const moongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const articleSchema = require('./articleSchema');
const articles = moongoose.model('article', articleSchema);
const connectionString = process.env.MONGODB_URI;
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const { getCache, setCache, deleteCache, invalidateCachePattern, isRedisAvailable } = require('./redisClient');

// Cache TTL in seconds (from .env or default 1 hour)
const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 3600;

/**
 * Get articles for multiple users in one request
 * Uses Redis cache if available, otherwise retrieves from database
 * 
 * @async
 * @function getArticlesInOneRequest
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
async function getArticlesInOneRequest(req, res)
{
    const usernames = req.query.usernames || ''; // This could be undefined if no usernames are specified
    let userList = usernames.split(','); // Assuming usernames are passed as a comma-separated list

    // Generate a cache key based on the usernames
    const cacheKey = `articles:multiple:${userList.sort().join('-')}`;

    try
    {
        // Only try cache if Redis is available
        if (isRedisAvailable())
        {
            // Try to get data from cache first
            const cachedArticles = await getCache(cacheKey);

            // If found in cache, return immediately
            if (cachedArticles)
            {
                console.log(`Cache hit for ${cacheKey}`);
                return res.send({ articles: cachedArticles, source: 'cache' });
            }

            console.log(`Cache miss for ${cacheKey}, fetching from database`);
        }

        // Not in cache or Redis not available, fetch from database
        await moongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

        const items = await articles.find({
            'author': { $in: userList }
        }).sort({ date: -1 }).exec(); // Sort by creation date and limit to 10

        // Only try to store in cache if Redis is available
        if (isRedisAvailable())
        {
            await setCache(cacheKey, items, CACHE_TTL);
        }

        return res.send({ articles: items, source: 'database' });
    } catch (error)
    {
        console.error('Error getting articles:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

/**
 * Get articles for current user or by specific ID
 * Uses Redis cache if available, otherwise retrieves from database
 * 
 * @async
 * @function getArticles
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
async function getArticles(req, res)
{
    const id = req.params.id;
    const username = req.username;

    try
    {
        let cacheKey;
        let cachedArticles = null;

        // Only try cache if Redis is available
        if (isRedisAvailable())
        {
            // Generate different cache keys based on the request type
            if (id && /^\d+$/.test(id))
            {
                cacheKey = `articles:id:${id}`;
            } else if (id)
            {
                cacheKey = `articles:author:${id}`;
            } else
            {
                cacheKey = `articles:user:${username}`;
            }

            // Try to get data from cache first
            cachedArticles = await getCache(cacheKey);

            // If found in cache, return immediately
            if (cachedArticles)
            {
                console.log(`Cache hit for ${cacheKey}`);
                return res.send({ articles: cachedArticles, source: 'cache' });
            }

            console.log(`Cache miss for ${cacheKey}, fetching from database`);
        }

        // Not in cache or Redis not available, fetch from database
        await moongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

        let result;

        // If an ID is provided, fetch a specific article
        if (id && /^\d+$/.test(id))
        {
            result = await articles.findOne({ id: id }).exec();
            if (!result) return res.status(404).send({ message: 'Article not found.' });
        } else if (id)
        {
            result = await articles.find({ author: id }).exec();
            if (!result) return res.status(404).send({ message: 'Article not found.' });
        } else
        {
            // Otherwise, fetch all articles for the current user
            result = await articles.find({ author: username }).sort({ date: -1 }).exec();
        }

        // Only try to store in cache if Redis is available
        if (isRedisAvailable() && cacheKey)
        {
            await setCache(cacheKey, result, CACHE_TTL);
        }

        return res.send({ articles: result, source: 'database' });
    } catch (error)
    {
        console.error('Error getting articles:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

async function addArticle(req, res)
{
    const username = req.username;
    const text = req.body.text;
    let img = '';

    if (req.file)
    {
        const result = await cloudinary.uploader.upload(req.file.path);
        img = result.url;
    }

    try
    {
        await moongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });
        // Find the article with the largest ID
        const lastArticle = await articles.findOne().sort({ id: -1 }).limit(1);
        const lastId = lastArticle ? lastArticle.id : 0;

        const newArticle = new articles({
            id: lastId + 1,
            author: username,
            text: text,
            date: new Date(),
            img: img,
            comments: []
        });

        // Save the new article
        await newArticle.save();

        // After successfully adding an article, invalidate relevant cache entries
        if (isRedisAvailable())
        {
            try
            {
                await Promise.all([
                    invalidateCachePattern(`articles:user:${username}`),
                    invalidateCachePattern(`articles:author:${username}`),
                    invalidateCachePattern(`articles:multiple:*${username}*`)
                ]);
            } catch (cacheError)
            {
                console.error('Cache invalidation error:', cacheError);
                // Continue even if cache invalidation fails
            }
        }

        res.status(201).send(newArticle);

    } catch (error)
    {
        console.error('Error adding article:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

async function editArticle(req, res)
{
    const id = parseInt(req.params.id); // Make sure to convert id to an integer if it's stored as a number
    const text = req.body.text;

    if (!text)
    {
        return res.status(400).send({ message: 'Text is required to update the article.' });
    }

    try
    {

        await moongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });
        // Update the article
        const updatedArticle = await articles.findOneAndUpdate(
            { id: id },
            { $set: { text: text } },
            { new: true } // Return the updated document
        );
        if (req.username !== updatedArticle.author)
        {
            return res.status(403).send({ message: 'Forbidden: You can only edit your own articles.' });
        }
        if (!updatedArticle)
        {
            return res.status(404).send({ message: 'Article not found.' });
        }

        // After successfully editing an article, invalidate relevant cache entries
        if (isRedisAvailable())
        {
            try
            {
                await Promise.all([
                    deleteCache(`articles:id:${id}`),
                    invalidateCachePattern(`articles:user:${updatedArticle.author}`),
                    invalidateCachePattern(`articles:author:${updatedArticle.author}`),
                    invalidateCachePattern(`articles:multiple:*${updatedArticle.author}*`)
                ]);
            } catch (cacheError)
            {
                console.error('Cache invalidation error:', cacheError);
                // Continue even if cache invalidation fails
            }
        }

        res.status(200).send(updatedArticle);
    } catch (error)
    {
        console.error('Error editing article:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

async function addComment(req, res)
{
    const username = req.username;
    const articleId = req.body.id; // Ensure this is the correct identifier for the article
    const commentText = req.body.text;
    const date = req.body.date;

    if (!commentText)
    {
        return res.status(400).send({ message: 'Text is required to add a comment.' });
    }

    try
    {
        await moongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

        // Find the article by ID and append the comment
        const result = await articles.updateOne(
            { id: articleId },
            { $push: { comment: { username, text: commentText, date: date } } }
        );

        if (result.nModified === 0)
        {
            return res.status(404).send({ message: 'Article not found.' });
        }

        res.status(200).send({ message: 'Comment added successfully.' });
    } catch (error)
    {
        console.error('Error adding comment:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

async function editComment(req, res)
{
    const username = req.username;
    const articleId = req.body.id;
    const commentId = req.body.commentId;

}

module.exports = (app) =>
{
    //app.get('/articles/', getArticles);
    app.get('/articles/:id?', getArticles);
    app.post('/articles', upload.single('image'), addArticle);
    app.put('/articles/:id', editArticle);
    app.put('/comment', addComment)
    app.put('/editComment', editComment)
    app.get('/getArticlesInOneRequest', getArticlesInOneRequest);

}
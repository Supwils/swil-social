const moongoose = require('mongoose');
const articleSchema = require('./articleSchema');
const e = require('express');
const { add } = require('./userSchema');
const articles = moongoose.model('articles', articleSchema);
const connectionString = 'mongodb+srv://[REDACTED]@[REDACTED]'

const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });


async function getArticlesInOneRequest(req, res) {
    const usernames = req.query.usernames ||  ''; // This could be undefined if no usernames are specified
    let userList = usernames.split(','); // Assuming usernames are passed as a comma-separated list
    
    try {
        await moongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

        // If usernames are provided, fetch articles from those users including the current user
        
            // Include the current user's username in the list
            //console.log(userList);
            const items = await articles.find({
                'author': { $in: userList }
            }).sort({ date: -1 }).exec(); // Sort by creation date and limit to 10

            return res.send({ articles: items });
        

        // If no usernames are provided, fetch all articles for the current user
        //const items = await articles.find({ 'username': req.username }).sort({ createdAt: -1 }).exec();
        //return res.send({ articles: items });

    } catch (error) {
        console.error('Error getting articles:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}


//get the current logged in user articles by req.username
async function getArticles(req, res) {
    const id = req.params.id; // This could be undefined if no ID is specified
    const username = req.username; // Assuming this is somehow set, maybe through middleware

    try {
        await moongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

        // If an ID is provided, fetch a specific article
        if(id && /^\d+$/.test(id)) {
            const item = await articles.findOne({ id: id }).exec(); // Assuming _id is the MongoDB default primary key
            if (!item) {
                return res.status(404).send({ message: 'Article not found.' });
            }
            return res.send({ articles: item });
        }
        else if (id) {
            const item = await articles.find({ author: id }).exec(); // Assuming _id is the MongoDB default primary key
            if (!item) {
                return res.status(404).send({ message: 'Article not found.' });
            }
            return res.send({ articles: item }); 
        }


        // If no ID is provided, fetch all articles for the user
        const items = await articles.find({ author: username }).exec();
        return res.send({ articles: items });

    } catch (error) {
        console.error('Error getting articles:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}


async function addArticle(req, res){
    const username = req.username;
    const text = req.body.text;
    let img = '';

    if (req.file) {
        const result = await cloudinary.uploader.upload(req.file.path);
        img = result.url; 
    }

    try {
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

        res.status(201).send(newArticle);

    } catch (error) {
        console.error('Error adding article:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}
async function editArticle(req, res) {
    const id = parseInt(req.params.id); // Make sure to convert id to an integer if it's stored as a number
    const text = req.body.text;

    if (!text) {
        return res.status(400).send({ message: 'Text is required to update the article.' });
    }

    try {
    
        await moongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });
        // Update the article
        const updatedArticle = await articles.findOneAndUpdate(
            { id: id }, 
            { $set: { text: text } }, 
            { new: true } // Return the updated document
        );
        if (req.username !== updatedArticle.author) {
            return res.status(403).send({ message: 'Forbidden: You can only edit your own articles.' });
        }
        if (!updatedArticle) {
            return res.status(404).send({ message: 'Article not found.' });
        }

        res.status(200).send(updatedArticle);
    } catch (error) {
        console.error('Error editing article:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

async function addComment(req, res) {
    const username = req.username;
    const articleId = req.body.id; // Ensure this is the correct identifier for the article
    const commentText = req.body.text;
    const date = req.body.date;

    if (!commentText) {
        return res.status(400).send({ message: 'Text is required to add a comment.' });
    }

    try {
        await moongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

        // Find the article by ID and append the comment
        const result = await articles.updateOne(
            { id: articleId },
            { $push: { comment: { username, text: commentText, date:date } } }
        );

        if (result.nModified === 0) {
            return res.status(404).send({ message: 'Article not found.' });
        }

        res.status(200).send({ message: 'Comment added successfully.' });
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

async function editComment(req,res){
    const username = req.username;
    const articleId = req.body.id;
    const commentId = req.body.commentId;
}

module.exports = (app) => {
    //app.get('/articles/', getArticles);
    app.get('/articles/:id?', getArticles);
    app.post('/articles', upload.single('image'), addArticle);
    app.put('/articles/:id', editArticle);
    app.put('/comment',addComment)
    app.put('/editComment',editComment)
    app.get('/getArticlesInOneRequest', getArticlesInOneRequest);

}
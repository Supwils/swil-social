const mongoose = require('mongoose');
const User = mongoose.model('user');
const Profile = mongoose.model('profile');

async function getFollowing(req, res) {
    try {
        const username = req.params.user || req.username;
        const user = await Profile.findOne({ username });
        if (!user) {
            return res.status(404).send({ message: 'User not found.' });
        }
        res.send({ username, following: user.following });
    } catch (error) {
        console.error('Failed to get following:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

async function addFollowing(req, res) {
    try {
        if (req.username === req.params.user) {
            return res.status(400).send({ message: 'Cannot follow yourself.' });
        }

        const user = await Profile.findOne({ username: req.username });
        const followingUser = await Profile.findOne({ username: req.params.user });

        if (!user || !followingUser) {
            return res.status(404).send({ message: 'User not found.' });
        }

        if (user.following.includes(req.params.user)) {
            return res.status(409).send({ message: 'Already following this user.' });
        }

        user.following.push(req.params.user);
        await user.save();
        res.send({ username: req.username, following: user.following });
    } catch (error) {
        console.error('Failed to add following:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

async function removeFollowing(req, res) {
    try {
        const user = await Profile.findOne({ username: req.username });
        if (!user) {
            return res.status(404).send({ message: 'User not found.' });
        }

        const newFollowingList = user.following.filter(user => user !== req.params.user);
        if (newFollowingList.length === user.following.length) {
            return res.status(404).send({ message: 'Following user not found.' });
        }

        user.following = newFollowingList;
        await user.save();
        res.send({ username: req.username, following: user.following });
    } catch (error) {
        console.error('Failed to remove following:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

module.exports = app => {
    app.get('/following/:user?', getFollowing);
    app.put('/following/:user', addFollowing);
    app.delete('/following/:user', removeFollowing);
}

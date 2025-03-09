const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const userSchema = require('./userSchema');
const profileSchema = require('./profileSchema');
const Profile = mongoose.model('profile', profileSchema);
const User = mongoose.model('user', userSchema);
require('dotenv').config();
const connectionString = process.env.MONGODB_URI;

const { sessionUser } = require('./index-passport');
let cookieKey = "sid";

let userObjs = {
    'admin': { password: bcrypt.hashSync('admin', 10), email: "admin@rice.edu", dob: new Date(1999, 11, 17).getTime(), zipcode: 77005 },
    'test': { password: bcrypt.hashSync('test', 10), email: "test@riceedu", dob: new Date(1999, 11, 17).getTime(), zipcode: 77005 }
};

function isLoggedIn(req, res, next)
{
    if (!req.cookies || !req.cookies[cookieKey])
    {
        console.log('Unauthorized: Session expired or not logged in.');
        return res.status(401).send({ message: 'Unauthorized: Session expired or not logged in.' });
    }

    let sid = req.cookies[cookieKey];
    let username = sessionUser[sid];


    if (username)
    {
        req.username = username;
        next();
    } else
    {
        return res.status(401).send({ message: 'Unauthorized: Invalid session.' });
    }
}

async function login(req, res)
{
    const { username, password } = req.body;

    if (!username || !password)
    {
        return res.status(400).send({ message: 'Bad Request: Username and password required.' });
    }

    try
    {
        // Connect to MongoDB
        await mongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

        // Find the user in the database
        const user = await User.findOne({ username });
        if (!user)
        {
            return res.status(401).send({ message: 'Unauthorized: User not found.' });
        }

        // Compare the provided password with the stored hashed password
        const isPasswordCorrect = await bcrypt.compare(password, user.password);
        if (!isPasswordCorrect)
        {
            return res.status(401).send({ message: 'Unauthorized: Invalid password.' });
        }

        // Create session
        const sid = bcrypt.hashSync(new Date().getTime().toString() + username, 10);
        sessionUser[sid] = username;
        res.cookie(cookieKey, sid, { maxAge: 3600 * 10000, httpOnly: true, secure: true, sameSite: 'none' });

        // Send success response
        res.send({ username, result: 'success' });

    } catch (error)
    {
        console.error('Failed to log in:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}


async function register(req, res)
{
    const { username, password, email, dob, zipcode, phone } = req.body;

    if (!username || !password)
    {
        return res.status(400).send({ message: 'Bad Request: Username and password required.' });
    }
    if (username === "testUser")
    {
        try
        {
            let usernameNew;
            await mongoose.connect(connectionString, {
                useNewUrlParser: true,
                useUnifiedTopology: true
            });

            // Check if a user with the username "testUser" exists
            const existingUsers = await User.find({ username: /^testUser\d*$/ });

            if (existingUsers.length > 0)
            {
                // Find the largest number suffix and increment it by 1
                const largestSuffix = existingUsers.reduce((maxSuffix, user) =>
                {
                    const match = user.username.match(/\d+$/);
                    if (match)
                    {
                        const suffix = parseInt(match[0]);
                        if (!isNaN(suffix) && suffix > maxSuffix)
                        {
                            return suffix;
                        }
                    }
                    return maxSuffix;
                }, 0);

                // Generate the new username
                usernameNew = `testUser${largestSuffix + 1}`;
            } else
            {
                // If no "testUser" exists, use "testUser1"
                usernameNew = "testUser1";
            }

            // Create a new user with the generated username

            // Hash the password
            const hashedPassword = bcrypt.hashSync(password, 10);

            // Save the new user
            const lastid = await User.findOne().sort({ id: -1 }).limit(1);
            const id = lastid ? lastid.id + 1 : 1;
            const newUser = new User({ id, username: usernameNew, password: hashedPassword, created: new Date() });
            const newProfile = new Profile({ id, username: usernameNew, phone, email, dob, zipcode, created: new Date() });
            await newUser.save();
            await newProfile.save();

            const sid = bcrypt.hashSync(new Date().getTime().toString() + usernameNew, 10);
            sessionUser[sid] = usernameNew;
            res.cookie(cookieKey, sid, { maxAge: 3600 * 1000, httpOnly: true, secure: true, sameSite: 'none' });

            // Respond with success
            res.status(200).send({ message: `User registered with username: ${usernameNew}` });
        } catch (error)
        {
            console.error('Failed to register user:', error);
            res.status(500).send({ error: 'Failed to add user' });
        }
    }

    else
    {
        try
        {
            // Connect to MongoDB
            await mongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

            // Check if username already exists
            const existingUser = await User.findOne({ username });
            if (existingUser)
            {
                return res.status(400).send({ message: 'Bad Request: User already exists.' });
            }

            // Hash the password
            const hashedPassword = bcrypt.hashSync(password, 10);

            // Save the new user
            const lastid = await User.findOne().sort({ id: -1 }).limit(1);
            const id = lastid ? lastid.id + 1 : 1;
            const newUser = new User({ id, username, password: hashedPassword, created: new Date() });
            const newProfile = new Profile({ id, username, email, phone, dob, zipcode, created: new Date() });
            await newUser.save();
            await newProfile.save();

            // Create session
            const sid = bcrypt.hashSync(new Date().getTime().toString() + username, 10);
            sessionUser[sid] = username;
            res.cookie(cookieKey, sid, { maxAge: 3600 * 1000, httpOnly: true, secure: true, sameSite: 'none' });

            // Send response
            res.send({ username, status: 'success' });

        } catch (error)
        {
            console.error('Failed to register user:', error);
            res.status(500).send({ error: 'Failed to add user' });
        }
    }

}
async function getPassword(req, res)
{
    try
    {
        await mongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

        const user = await User.findOne({ username: req.username });
        if (!user)
        {
            return res.status(401).send({ message: 'Unauthorized: User not found.' });
        }
        return res.send({ password: user.password });
    }
    catch (error)
    {
        console.error('Failed to get password:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}

async function changePassword(req, res)
{
    const newPassword = req.body.password;
    if (!newPassword)
    {
        return res.status(400).send({ message: 'Bad Request: Password required.' });
    }

    try
    {
        // Connect to MongoDB
        await mongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

        // Find the logged in user
        const user = await User.findOne({ username: req.username });
        if (!user)
        {
            return res.status(401).send({ message: 'Unauthorized: User not found.' });
        }

        // Hash the new password
        const hashedPassword = bcrypt.hashSync(newPassword, 10);

        // Update the user's password
        user.password = hashedPassword;
        await user.save();

        //update the session information here if necessary

        // Send success response
        res.send({ message: 'Password changed successfully.' });
    } catch (error)
    {
        console.error('Failed to change password:', error);
        res.status(500).send({ error: 'Internal Server Error' });
    }
}


function logout(req, res)
{
    let sid = req.cookies[cookieKey];
    delete sessionUser[sid];
    res.clearCookie(cookieKey);
    res.send({ message: 'OK' });
}

module.exports = (app) =>
{
    app.post('/login', login);
    app.post('/register', register);
    app.put('/password', isLoggedIn, changePassword)
    app.get('/password', isLoggedIn, getPassword)
    app.put('/logout', isLoggedIn, logout);
    app.use(isLoggedIn);
}

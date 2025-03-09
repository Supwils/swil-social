const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth').OAuth2Strategy;
const bodyParser = require('body-parser');


const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const userSchema = require('./userSchema');
const profileSchema = require('./profileSchema');
const Profile = mongoose.model('profile', profileSchema);
const User = mongoose.model('user', userSchema);
require('dotenv').config();
const connectionString = process.env.MONGODB_URI;

let sessionUser = {};
let cookieKey = "sid";


module.exports = app =>
{

    app.use(session({
        secret: 'doNotGuessTheSecret',
        resave: true,
        saveUninitialized: true
    }));

    app.use(passport.initialize());
    app.use(passport.session());

    passport.serializeUser(function (user, done)
    {
        done(null, user);
    });

    passport.deserializeUser(function (user, done)
    {
        done(null, user);
    });

    passport.use(new GoogleStrategy({
        clientID: '763460184092-kb5dttiutkbvfgltgro081ds3gqmjq7g.apps.googleusercontent.com',
        clientSecret: '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',
        callbackURL: "/auth/google/callback"
    },
        async function (accessToken, refreshToken, profile, done)
        {
            try
            {

                email = profile.emails[0].value;
                const name = profile.displayName;


                // Connect to MongoDB
                await mongoose.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true });

                // Check if the user exists
                let user = await Profile.findOne({ email: email });
                if (!user)
                {
                    const lastid = await User.findOne().sort({ id: -1 }).limit(1);
                    const id = lastid ? lastid.id + 1 : 1;
                    // If user doesn't exist, create a new one
                    const newUser = new User({
                        id: id,
                        // Set the user properties
                        username: name,
                        password: bcrypt.hashSync('1234', 10),
                        created: new Date()
                        // ... other properties ...
                    });
                    const newProfile = new Profile({
                        id: id,
                        username: name,
                        email: email,
                        created: new Date()
                        // ... other properties ...
                    });
                    await newUser.save();
                    user = newUser;
                    await newProfile.save();

                }
                const sid = bcrypt.hashSync(new Date().getTime().toString() + user.username, 10);
                sessionUser[sid] = user.username;

                return done(null, { username: user.username, sid: sid });
            } catch (error)
            {
                console.error('Error during Google authentication:', error);
                return done(error, null);
            }
        }));
    // Redirect the user to Google for authentication.  When complete,
    // Google will redirect the user back to the application at
    //     /auth/google/callback
    app.get('/auth/google', passport.authenticate('google', { scope: ['https://www.googleapis.com/auth/plus.login', 'email'] })); // could have a passport auth second arg {scope: 'email'}

    // Google will redirect the user to this URL after approval.  Finish the
    // authentication process by attempting to obtain an access token.  If
    // access was granted, the user will be logged in.  Otherwise,
    // authentication has failed.
    app.get('/auth/google/callback',
        passport.authenticate('google', { failureRedirect: '/' }),
        (req, res) =>
        {
            // Set cookie with the sid
            res.cookie(cookieKey, req.user.sid, { maxAge: 3600 * 10000, httpOnly: true, secure: true, sameSite: 'none' });
            const frontendRedirectUrl = `https://hs87-final-frontend.surge.sh/login?username=${encodeURIComponent(req.user.username)}&isLoggedIn=true`;
            res.redirect(frontendRedirectUrl);
        });

    //express endpoints would normally start here

}
module.exports.sessionUser = sessionUser;
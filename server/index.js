const auth = require('./src/auth');
const article = require('./src/articles');
const profile = require('./src/profile');
const following = require('./src/following');
const passport = require('./src/index-passport');
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const mongoose = require('mongoose');
const userSchema = require('./src/userSchema');
const User = mongoose.model('user', userSchema);
const connectionString = 'mongodb+srv://[REDACTED]@[REDACTED]'

// const corsOptions = {origin:"https://hs87-final-frontend.surge.sh/",
//                     methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
//                     credentials:true};
const corsOptions = {origin:"http://localhost:3000",
                    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
                    credentials:true};
//const upCloud = require('./backend/src/uploadCloudary.js') 

const hello = (req, res) => res.send({ hello: 'world' });
//add a change

const app = express();
app.use(cors(corsOptions));
//upCloud.setup(app) 
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get('/', hello);
passport(app);
auth(app);
article(app);
profile(app);
following(app);


// Get the port from the environment, i.e., Heroku sets it
const port = process.env.PORT || 8888;
const server = app.listen(port, () => {
     const addr = server.address();
     console.log(`Server listening at http://${addr.address}:${addr.port}`)
});
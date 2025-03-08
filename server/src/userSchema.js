const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  id:{
    type: Number,
    required: [true, 'ID is required']
  },
  username: {
    type: String,
    required: [true, 'Username is required']
  },
  password:{
    type: String,
    required: [true, 'Password is required']
  },
  created:{
    type: Date,
    required: [true, 'Created is required']
  }
})

module.exports = userSchema;
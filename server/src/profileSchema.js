const mongoose = require('mongoose');

const profileSchema = new mongoose.Schema({
  id:{
    type: Number,
    required: [true, 'Id is required']
  },
  username: {
    type: String,
    required: [true, 'Username is required']
  },
  email: {
    type: String,
    default: ''
  },
  dob: {
    type: Date,
    default: ''
  },
  phone: {
    type: String,
    default: ''
  },
  zipcode:{
    type: String,
    default: ''
  },
  following : {
    type: [String],
    default: []
  },
  avatar: {
    type: String,
    default: ''
  },
  headline: {
    type: String,
    default: ''
  },
  created: {
    type: Date,
    required: [true, 'Created date is required']
  }
})

module.exports = profileSchema;
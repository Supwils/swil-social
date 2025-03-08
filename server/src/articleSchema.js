const mongoose = require('mongoose');

const articleSchema = new mongoose.Schema({
    id:{
        type: Number,
    },
    author:{
        type: String,
        required: [true, 'author is required']
    },
    text:{
        type: String,
        required: [true, 'text is required']
    },
    date:{
        type: Date,
    },
    img:{
        type: String,
        default: ''
    },
    comment:{
        type: Array,
        default: []
    },
    }
)

module.exports = articleSchema;
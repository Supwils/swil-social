const cloudinary = require('cloudinary').v2;
          

cloudinary.config({ 
  cloud_name: 'dsghhvkhk', 
  api_key: '234756362129292', 
  api_secret: 'RXUjvhsgR3qqbsDS69BsHAGoxhk' 
});

module.exports = cloudinary;
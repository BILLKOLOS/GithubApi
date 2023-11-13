const mongoose = require('mongoose');
const passportLocalMongoose = require('passport-local-mongoose');

const userSchema = new mongoose.Schema({
  username: String,
  password: String,
});

// Plugin Passport-Local Mongoose for additional functionality
userSchema.plugin(passportLocalMongoose);

// Create the User model
const User = mongoose.model('User', userSchema);

module.exports = User;

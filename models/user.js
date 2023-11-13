const Sequelize = require('sequelize');

const sequelize = new Sequelize('github_api', 'postgres', 'Bill2020$2019', {
  host: 'localhost',
  dialect: 'postgres',
});

const User = sequelize.define('user', {
  username: {
    type: Sequelize.STRING,
    unique: true,
    allowNull: false,
  },
  password: {
    type: Sequelize.STRING,
    allowNull: false,
  },
});

module.exports = User;


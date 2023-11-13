const express = require('express');
const axios = require('axios');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const session = require('express-session');
const bodyParser = require('body-parser');

const app = express();
const port = 3000;

// Set up session middleware
app.use(session({ secret: 'your-secret-key', resave: false, saveUninitialized: false }));

// Set up Passport.js
app.use(passport.initialize());
app.use(passport.session());
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory user database (replace with a database in a real application)
const users = [
  { id: 1, username: 'user1', password: 'password1' },
  { id: 2, username: 'user2', password: 'password2' },
];

// Passport.js local strategy
passport.use(new LocalStrategy(
  (username, password, done) => {
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
      return done(null, user);
    } else {
      return done(null, false, { message: 'Incorrect username or password.' });
    }
  }
));

// Serialize and deserialize user for session support
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  const user = users.find(u => u.id === id);
  done(null, user);
});

// Middleware to check if a user is authenticated
function isLoggedIn(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login');
}

// Input validation
const isValidUsername = (username) => /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/.test(username);

// Helper functions
const errorResponse = (res, status, message) => res.status(status).send(`<h2>Error: ${message}</h2>`);
const styledHtmlResponse = (res, content) => res.send(`
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body {
        font-family: 'Arial', sans-serif;
        text-align: center;
        margin: 20px;
      }
      h1, h2 {
        color: #0366d6;
      }
      ul {
        list-style-type: none;
        padding: 0;
      }
      li {
        border: 1px solid #ddd;
        margin: 5px;
        padding: 10px;
        border-radius: 5px;
      }
    </style>
  </head>
  <body>
    ${content}
  </body>
  </html>
`);

// Welcome message with HTML and a form
app.get('/', (req, res) => {
  styledHtmlResponse(res, `
    <h1>Welcome to the GitHub User Info App!</h1>
    <form action="/github/users" method="GET">
      <label for="usernames">Enter GitHub usernames (comma-separated):</label>
      <input type="text" id="usernames" name="usernames" required>
      <button type="submit">Get Info</button>
    </form>
    <br>
    <a href="/login">Login</a> | <a href="/logout">Logout</a> | <a href="/protected">Protected Route</a> | <a href="/signup">Sign Up</a>
  `);
});

// Render user information in an HTML template with input validation
app.get('/github/users', async (req, res) => {
  const inputUsernames = req.query.usernames;

  // Validate input usernames
  if (!inputUsernames || !inputUsernames.trim()) {
    return errorResponse(res, 400, 'Please enter GitHub usernames.');
  }

  const usernames = inputUsernames.split(',').map(username => username.trim());

  if (usernames.some(username => !isValidUsername(username))) {
    return errorResponse(res, 400, 'Invalid GitHub username(s).');
  }

  try {
    const usersData = await Promise.all(
      usernames.map(async (username) => {
        const response = await axios.get(`https://api.github.com/users/${username}`);
        return {
          name: response.data.name,
          followers: response.data.followers,
          following: response.data.following,
        };
      })
    );

    // Render user information in an HTML template
    const htmlResponse = `
      <h1>GitHub User Information</h1>
      <ul>
        ${usersData.map(user => `
          <li>
            <strong>${user.name}</strong>
            <p>Followers: ${user.followers}</p>
            <p>Following: ${user.following}</p>
          </li>
        `).join('')}
      </ul>
    `;

    styledHtmlResponse(res, htmlResponse);
  } catch (error) {
    console.error(error);
    errorResponse(res, 500, 'Internal Server Error');
  }
});

// New route to retrieve a list of user's repositories
app.get('/github/repos/:username', async (req, res) => {
  const username = req.params.username;

  try {
    const response = await axios.get(`https://api.github.com/users/${username}/repos`);
    const repositories = response.data.map(repo => ({
      name: repo.name,
      description: repo.description,
      stargazersCount: repo.stargazers_count,
      forksCount: repo.forks_count,
    }));

    const htmlResponse = `
      <h1>GitHub Repositories for ${username}</h1>
      <ul>
        ${repositories.map(repo => `
          <li>
            <strong>${repo.name}</strong>
            <p>Description: ${repo.description || 'No description available.'}</p>
            <p>Stars: ${repo.stargazersCount}</p>
            <p>Forks: ${repo.forksCount}</p>
          </li>
        `).join('')}
      </ul>
    `;

    styledHtmlResponse(res, htmlResponse);
  } catch (error) {
    console.error(error);
    if (error.response && error.response.status === 404) {
      // Handle case where the user does not exist
      return errorResponse(res, 404, 'User not found');
    }
    errorResponse(res, 500, 'Internal Server Error');
  }
});

// New route to retrieve contributors for a GitHub repository
app.get('/github/repos/:owner/:repo/contributors', async (req, res) => {
  const { owner, repo } = req.params;

  try {
    const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/contributors`);
    const contributors = response.data.map(contributor => ({
      username: contributor.login,
      contributions: contributor.contributions,
    }));

    const htmlResponse = `
      <h1>GitHub Repository Contributors</h1>
      <ul>
        ${contributors.map(contributor => `
          <li>
            <strong>${contributor.username}</strong>
            <p>Contributions: ${contributor.contributions}</p>
          </li>
        `).join('')}
      </ul>
    `;

    styledHtmlResponse(res, htmlResponse);
  } catch (error) {
    console.error(error);
    if (error.response && error.response.status === 404) {
      // Handle case where the repository does not exist
      return errorResponse(res, 404, 'Repository not found');
    }
    errorResponse(res, 500, 'Internal Server Error');
  }
});

// Signup route
app.get('/signup', (req, res) => {
  res.send(`
    <h1>Sign Up</h1>
    <form action="/signup" method="post">
      <label for="username">Username:</label>
      <input type="text" id="username" name="username" required>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required>
      <button type="submit">Sign Up</button>
    </form>
    <br>
    <a href="/login">Login</a> | <a href="/logout">Logout</a> | <a href="/protected">Protected Route</a> | <a href="/">Home</a>
  `);
});

// Handle signup form submission
app.post('/signup', (req, res) => {
  const { username, password } = req.body;

  // Check if the username is already taken
  if (users.some(user => user.username === username)) {
    return res.send('<h2>Error: Username already taken. Please choose another.</h2>');
  }

  // Create a new user
  const newUser = {
    id: users.length + 1,
    username,
    password,
  };

  // Add the new user to the users array (replace with a database operation in a real application)
  users.push(newUser);

  // Redirect to the login page after successful signup
  res.redirect('/login');
});

// Login route
app.get('/login', (req, res) => {
  res.send(`
    <h1>Login</h1>
    <form action="/login" method="post">
      <label for="username">Username:</label>
      <input type="text" id="username" name="username" required>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required>
      <button type="submit">Login</button>
    </form>
    <br>
    <a href="/signup">Sign Up</a> | <a href="/logout">Logout</a> | <a href="/protected">Protected Route</a> | <a href="/">Home</a>
  `);
});

// Handle login form submission
app.post('/login', passport.authenticate('local', {
  successRedirect: '/',
  failureRedirect: '/login',
}));

// Logout route
app.get('/logout', (req, res) => {
  req.logout();
  res.redirect('/');
});

// Protected route
app.get('/protected', isLoggedIn, (req, res) => {
  res.send(`<h1>Protected Route - Welcome, ${req.user.username}!</h1>`);
});

// Updated app.listen to make the server accessible externally
app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening at http://0.0.0.0:${port}`);
});

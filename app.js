const express = require('express');
const axios = require('axios');
const app = express();
const port = 3000;

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

// Updated app.listen to make the server accessible externally
app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening at http://0.0.0.0:${port}`);
});



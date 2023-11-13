# GitHub User Info App

This is a simple Express.js application that allows users to retrieve information about GitHub users, their repositories, and contributors to specific repositories.

## Features

1. **User Information:**
   - Enter one or more GitHub usernames to get information about their followers and following.

2. **Repository Information:**
   - Retrieve a list of repositories for a specific GitHub user, including details such as repository name, description, stars, and forks.

3. **Contributors Information:**
   - Get a list of contributors for a particular GitHub repository, along with their contribution counts.

## Prerequisites

- [Node.js](https://nodejs.org/) installed on your machine.
- An internet connection to access the GitHub API.

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/your-username/your-repo.git
Navigate to the project directory:

cd your-repo
Install dependencies:

npm install
Usage
Start the server:

npm start
Open a web browser and access the application at http://localhost:3000.

Follow the on-screen instructions to retrieve GitHub user information, repository details, and contributors.

Routes
/github/users:

Retrieve information about GitHub users.
Parameters: usernames (comma-separated).
/github/repos/:username:

Retrieve a list of repositories for a specific GitHub user.
Parameters: username.
/github/repos/:owner/:repo/contributors:

Retrieve contributors for a specific GitHub repository.
Parameters: owner (GitHub username) and repo (repository name).
Examples
Retrieve user information:

http://localhost:3000/github/users?usernames=billkolos
Retrieve user repositories:

http://localhost:3000/github/repos/billkolos
Retrieve contributors to a repository:

http://localhost:3000/github/repos/billkolos/printf/contributors
Contributing
Feel free to contribute to this project by opening issues, submitting pull requests, or suggesting improvements. Your contributions are highly appreciated.

License
This project is licensed under the MIT License - see the LICENSE file for details

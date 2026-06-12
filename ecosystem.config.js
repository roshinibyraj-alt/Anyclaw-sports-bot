// Railway: Set PRIVATE_KEY in Railway dashboard environment variables
module.exports = {
  apps: [{
    name: 'polymarket-bot',
    script: 'index.js',
    max_memory_restart: '300M',
    env: {
      PRIVATE_KEY: process.env.PRIVATE_KEY || ""
    }
  }]
};

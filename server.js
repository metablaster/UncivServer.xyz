require('dotenv').config();
const axios = require('axios');
const express = require('express');
const { MongoClient } = require('mongodb');
const { gzipSync, gunzipSync } = require('zlib');
const { readFileSync, writeFileSync, existsSync, rmSync } = require('fs');

// Battle Royale Games
var BattleRoyaleGames = new Set();

// error logger
const errorLogger = e => console.error(e.stack);

// Discord
const discordApiEndpoint = 'https://discord.com/api/v10';

const dicord = axios.create({
  baseURL: discordApiEndpoint,
  headers: {
    Accept: 'application/json',
    Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
  },
});

// Cloudflare KV, comment for now
/*async function getValueFromKV(key) {
  try {
    return await axios
      .get(
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE}/values/${key}`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${process.env.CF_KV_AUTH}`,
          },
        }
      )
      .then(res => res.data);
  } catch (e) {
    return null;
  }
}*/

// express
var server = express();

server.locals.mongoClient = new MongoClient(process.env.MongoURL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

server.use(function (req, res, next) {
  req.path = req.path.replace(/\/{2,}/g, '/').replace(/\s+/g, '');
  if (
    !req.path.startsWith('/assets') &&
    (req.path.startsWith('/node_modules') || req.path.endsWith('.js'))
  ) {
    res.sendStatus(403);
    return;
  }
  if (req.path.startsWith('/files')) {
    res.set('Cache-Control', 'public, max-age=2');
    res.set('Content-Type', 'text/plain');
  }
  next();
});

server.use(express.static('.', { limit: '5mb' }));

// Limit, 3 MegaBytes
// 1 << 10 = 1024 << 10 = 1024 * 1024
const limit = 3 << 20;

// Text Body Parser
server.use(function (req, res, next) {
  let ln = req.get('content-length');
  if (ln && ln > limit) {
    res.sendStatus(413);
    return;
  }
  req.body = '';
  let overLimit = false;
  req.on('data', chunk => {
    if (overLimit) return;
    req.body += chunk;
    if (req.body.length > limit) {
      overLimit = true;
      res.sendStatus(413);
      return;
    }
  });
  req.on('end', () => {
    if (!overLimit) next();
  });
});

server.get('/isalive', async (req, res) => {
  res.end('true');
});

server.get('/files/:fileName', async (req, res) => {
  const { db } = server.locals;
  const { fileName } = req.params;

  // MongoDB
  var fileData = await db.UncivServer.findOne(
    { _id: fileName },
    { projection: { _id: 0, text: 1 } }
  ).catch(errorLogger);

  if (fileData) {
    writeFileSync(req.path.slice(1), fileData.text);
    res.end(fileData.text);
    return;
  }

  // Workers KV
  // Comment for Now
  /*fileData = await getValueFromKV(fileName);
  if (fileData) {
    writeFileSync(req.path.slice(1), fileData);
    await db.UncivServer.insertOne({ _id: fileName, timestamp: Date.now(), text: fileData });
    res.end(fileData.text);
    return;
  }
  console.dir(fileData);*/

  // Dropbox
  try {
    const { status, data } = await axios
      .get('https://content.dropboxapi.com/2/files/download', {
        headers: {
          'Dropbox-API-Arg': `{"path": "/MultiplayerGames/${fileName}"}`,
          Authorization: 'Bearer LTdBbopPUQ0AAAAAAAACxh4_Qd1eVMM7IBK3ULV3BgxzWZDMfhmgFbuUNF_rXQWb',
        },
      })
      .catch(err => err.response || {});

    if (!status) {
      res.sendStatus(404);
      return;
    }

    // Log Dropbox Response
    console.log('Dropbox Status:', status);
    if (status !== 200) console.log('Dropbox Data:', data);

    res.status(status);
    if (typeof data === 'string') res.end(data);
    else res.send(data);
  } catch (err) {
    errorLogger(err);
    res.sendStatus(404);
  }
});

const gameRegex = /^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/;

server.post('/addbrgame/:gameID', async (req, res) => {
  if (req.body !== process.env.BRAuth) {
    res.sendStatus(403);
    return;
  }

  const { gameID } = req.params;

  if (!gameID || !gameRegex.test(gameID)) {
    res.sendStatus(400);
    return;
  }

  if (BattleRoyaleGames.has(gameID)) {
    res.status(200).end('Already Added');
    return;
  }

  const path = `files/${gameID}`;

  if (!existsSync(path)) {
    res.sendStatus(404);
    return;
  }

  BattleRoyaleGames.add(gameID);
  res.sendStatus(200);
});

const gamePreviewRegex = /^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}_Preview$/;

server.put('/files/:fileName', async (req, res) => {
  if (!req.body) {
    console.dir(req);
    res.sendStatus(400);
    return;
  }

  if (BattleRoyaleGames.has(req.params.fileName)) handleBRGame(req);

  writeFileSync(req.path.slice(1), req.body);
  await server.locals.db.UncivServer.updateOne(
    { _id: req.params.fileName },
    { $set: { timestamp: Date.now(), text: req.body } },
    { upsert: true }
  );
  res.sendStatus(200);

  // If fileName is game Preview type
  if (gamePreviewRegex.test(req.params.fileName)) {
    const gameID = req.params.fileName.slice(0, -8);

    const { civilizations, currentPlayer, turns, gameParameters } = UncivParser.parse(req.body);

    // Log & exit if invalid data
    console.dir({ turns, currentPlayer, civilizations }, { depth: null });
    if (!currentPlayer || !civilizations) return;

    // find currentPlayer's ID
    const { playerId } = civilizations.find(c => c.civName === currentPlayer);
    if (!playerId) return;

    // Check if the Player exists in DB
    const queryResponse = await server.locals.db.PlayerProfiles.findOne(
      { uncivUserIds: playerId },
      { projection: { notifications: 1, dmChannel: 1 } }
    ).catch(errorLogger);

    if (queryResponse) {
      if (!queryResponse.dmChannel) {
        try {
          const dmChannel = await dicord
            .post('/users/@me/channels', { recipient_id: queryResponse._id })
            .then(ch => ch.data.id);
          await server.locals.db.PlayerProfiles.updateOne(
            { _id: queryResponse._id },
            { $set: { dmChannel } }
          );
          queryResponse.dmChannel = dmChannel;
        } catch (err) {
          errorLogger(err);
        }
      }
    } else return;

    // Unique list of Players
    const players = [
      ...new Set(
        gameParameters.players
          .concat(civilizations)
          .map(c => c.playerId)
          .filter(id => id)
      ),
    ];

    const { name } = (
      await server.locals.db.UncivServer.findOneAndUpdate(
        { _id: req.params.fileName },
        { $set: { currentPlayer, playerId, turns: turns || 0, players } },
        { projection: { _id: 0, name: 1 } }
      )
    ).value;

    if (!queryResponse.dmChannel || queryResponse.notifications !== 'enabled') return;
    await dicord
      .post(`/channels/${queryResponse.dmChannel}/messages`, {
        embeds: [
          {
            color: Math.floor(0x1000000 * Math.random()),
            author: {
              name: 'UncivServer.xyz Turn Notification',
              icon_url:
                'https://cdn.discordapp.com/avatars/866759632617996308/fda14396efe2014f5f50666e5bcc4730.png',
            },
            fields: [
              {
                name: !name ? 'game ID' : 'Name',
                value: `\`\`\`${name || gameID}\`\`\``,
                inline: false,
              },
              {
                name: 'Your Civ',
                value: `\`\`\`${currentPlayer}\`\`\``,
                inline: true,
              },
              {
                name: 'Current Turn',
                value: `\`\`\`${turns || 0}\`\`\``,
                inline: true,
              },
              {
                name: 'Players',
                value: `\`\`\`${civilizations
                  .filter(c => c.playerType === 'Human')
                  .map(c => c.civName)
                  .join(', ')}\`\`\``,
                inline: false,
              },
            ],
          },
        ],
      })
      .catch(errorLogger);
  }
});

server.delete('/files/:fileName', async (req, res) => {
  rmSync(req.path.slice(1), { force: true });
  await server.locals.db.UncivServer.deleteOne({ _id: req.params.fileName }).catch(errorLogger);
  res.sendStatus(200);
});

function distanceToCenter(pos) {
  if (typeof pos !== 'object') return 0;

  pos.x = pos.x || 0;
  pos.y = pos.y || 0;

  return Math.max(Math.abs(pos.x), Math.abs(pos.y), Math.abs(pos.x - pos.y));
}

function handleBRGame(req) {
  let json = UncivParser.parse(req.body);

  let { radius } = json.tileMap.mapParameters.mapSize;

  // Stop when radius becomes 0
  if (!radius) return;

  // Cut last radius tiles of the tileList
  let cut = 1 + 3 * radius * (radius - 1);
  json.tileMap.tileList = json.tileMap.tileList.slice(0, cut);

  let unitCount = {};

  // Remove deleted tiles from exploredTiles of Civs
  json.civilizations = json.civilizations.map(civ => {
    if (civ.exploredTiles) {
      civ.exploredTiles = civ.exploredTiles.filter(p => distanceToCenter(p) < radius);
    }
    unitCount[civ.civName] = 0;
    return civ;
  });

  console.log(unitCount);

  // Remove deleted tiles from movementMemories
  json.tileMap.tileList = json.tileMap.tileList.map(t => {
    if (t.militaryUnit && t.militaryUnit.movementMemories) {
      ++unitCount[t.militaryUnit.owner];
      t.militaryUnit.movementMemories = t.militaryUnit.movementMemories.filter(
        m => distanceToCenter(m.position) < radius
      );
    }
    if (t.civilianUnit && t.civilianUnit.movementMemories) {
      ++unitCount[t.civilianUnit.owner];
      t.civilianUnit.movementMemories = t.civilianUnit.movementMemories.filter(
        m => distanceToCenter(m.position) < radius
      );
    }
    return t;
  });

  // Remove Barbarians Camps in deleted tiles
  if (json.barbarians && json.barbarians.camps) {
    Object.entries(json.barbarians.camps).forEach(entry => {
      [key, { position }] = entry;
      if (distanceToCenter(position) >= radius) {
        delete json.barbarians.camps[key];
      }
    });
  }

  // Decease radius by 1
  json.tileMap.mapParameters.mapSize.radius--;

  req.body = UncivParser.stringify(json);
}

// Start Server
(async () => {
  // Initialize MongoDB
  console.dir('Initializing MongoDB ...');
  await server.locals.mongoClient.connect();
  server.locals.db = {
    UncivServer: await server.locals.mongoClient.db('unciv').collection('UncivServer'),
    PlayerProfiles: await server.locals.mongoClient.db('unciv').collection('PlayerProfiles'),
  };
  console.dir('MongoBD Initiated !');

  // start server
  server.listen(process.env.PORT || 8080, async () => {
    console.dir(`Listening on ${process.env.PORT || 8080} ...`);
  });
})();

// error handler
process.on('error', errorLogger);

// a recursive json parser written by me for the game json output of unciv
// doesn't support whitespaces
const UncivParser = (() => {
  const parseUncivJson = (() => {
    function parseData(str) {
      if (typeof str == 'string') {
        if (str == 'true') return true;
        if (str == 'false') return false;
        let num = Number(str);
        if (!isNaN(num)) str = num;
        if (typeof str == 'string' && str.startsWith('"') && str.endsWith('"')) {
          return str.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
        }
      }
      return str;
    }

    function parser() {
      if (str.at(i) == '[') {
        let array = [];

        while (str.at(++i) != ']') {
          if (str.at(i) == '[' || str.at(i) == '{') array.push(parser());

          let value = '';
          while (str.at(i) != ',' && str.at(i) != ']') {
            value += str.at(i++);
          }

          if (value) array.push(parseData(value));

          if (str.at(i) == ']') break;
        }

        i += 1;
        return array;
      }

      let object = {};

      while (str.at(++i) != '}') {
        let param = '';
        while (str.at(i) != ':') {
          param += str.at(i++);
        }

        ++i;
        let value = '';
        if (str.at(i) == '[' || str.at(i) == '{') value = parser();
        while (str.at(i) && str.at(i) != ',' && str.at(i) != '}') {
          value += str.at(i++);
        }

        object[parseData(param)] = parseData(value);

        if (str.at(i) == '}') break;
      }

      ++i;
      return object;
    }

    var i = 0;
    var str = '';

    return function (s) {
      i = 0;
      str = s;
      return parser();
    };
  })();

  return {
    parse(gameData) {
      const jsonText = gunzipSync(Buffer.from(gameData, 'base64')).toString();
      return parseUncivJson(jsonText);
    },
    stringify(json) {
      const jsonText = JSON.stringify(json);
      return gzipSync(jsonText).toString('base64');
    },
    parseFromFile(path) {
      if (!existsSync(path)) return null;
      const gameData = readFileSync(path, 'utf8');
      return this.parse(gameData);
    },
  };
})();

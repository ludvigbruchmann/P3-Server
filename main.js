var dgram = require('dgram');
var client = dgram.createSocket('udp4');

// express
var express = require('express');
var bodyParser = require('body-parser');
var app = express(); // define our app using express

// database
var Datastore = require('nedb');
var db = {};

var fs = require('fs');

// config & app info
var config = require('./config');
var appInfo = JSON.parse(fs.readFileSync('package.json', 'utf8'));

// database setup

db.devices = new Datastore({
  filename: config.databaseLocation + 'devices.db',
  autoload: true
});

// user authentication

var bcrypt = require('bcrypt');

db.userdata = new Datastore({
  filename: config.databaseLocation + 'userdata.db',
  autoload: true
});

db.tags = new Datastore({
  filename: config.databaseLocation + 'tags.db',
  autoload: true
});

db.sessions = new Datastore(); // In-memory only

// random functions

function format(str) {
  var args = [].slice.call(arguments, 1),
    i = 0;
  return str.replace(/%s/g, function() {
    return args[i++];
  });
}

function currentTime() {
  var date = new Date();
  return format("%s:%s:%s",
    (date.getHours()<10?'0':'') + date.getHours(),
    (date.getMinutes()<10?'0':'') + date.getMinutes(),
    (date.getSeconds()<10?'0':'') + date.getSeconds()
  )
}

function debugMessage(msg) {
  if (config.debug) {
    console.log(
      format('[%s] %s', currentTime(), msg)
    );
  }
}

// global variables, yeah I'm that lazy

var newScanPromt = new Date(0); // update on new tag scan prompt from client.android, allows for new scan timeout

// service discovery

client.on('error', (err) => {
	console.log('Server Error:\n${err.stack}');
	client.close();
});

client.on('listening', function () {
  var address = client.address();
  debugMessage(
    format('Service discovery running on port %s', config.port)
  );
  client.setBroadcast(true);
});

client.on('message', function (message, rinfo) {
  debugMessage(
    format('%s:%s @ service discovery : %s', rinfo.address, rinfo.port, message)
  );
  client.send(message, 0, message.length, rinfo.port, rinfo.address);
});

client.bind(config.port);

// http server

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

var router = express.Router();

router.use(function(req, res, next) {
  debugMessage(
    format('%s @ %s', req.headers['x-forwarded-for'] || req.connection.remoteAddress, req.originalUrl)
  );
  next();
});

// endpoints

router.get('/', function(req, res) {
  res.sendStatus(200);
});

router.get('/package.json', function(req, res) {
  res.json(appInfo);
});

router.post('/register', function(req, res) {
  ip_address = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (req.body.device_type) {
    db.devices.insert({
      device_type: req.body.device_type,
      register_time: new Date(),
      ip_address: ip_address
    }, function(err, doc) {
      res.json(doc);
    });
  } else {
    res.sendStatus(400); // #TODO: Error codes
  }
});

router.get('/devices', function(req, res) {
  db.devices.find({}, function(err, docs) {
    res.json(docs);
  });
});

router.get('/tags', function(req, res) {
  db.tags.find({}, function(err, docs) {
    res.json(docs);
  });
});

// client.android #TODO: add auth for "production".

router.get('/scan/new', function(req, res) {
  newScanPromt = new Date();
  res.sendStatus(200);
});

// nodemcu.f_module

router.post('/scan', function(req, res) {
  if (req.body.mac_address && req.body.tag) {
    if ( newScanPromt.getTime() + config.newScanPromtTimeout > new Date().getTime() ) { // if promted to scan new tag
      debugMessage('Scanning new tag ' + req.body.tag);
      db.tags.findOne({ tag: req.body.tag }, function(err, docs) {
        if ( !docs ) {
          tempObject = {
            tag: req.body.tag,
            name: req.body.tag,
            desc: "",
            time: new Date()
          };
          db.tags.insert(tempObject);
          res.json(tempObject);
          // #TODO: send message to client.android
        } else {
          res.sendStatus(409); // conflict, tag already exists
        }
      });
      newScanPromt = new Date(0);
    } else {
      db.tags.findOne({ tag: req.body.tag }, function(err, docs) {
        if ( docs ) { // success! we scanned a tag that already exists.
          res.json(docs);
        } else {
          res.sendStatus(404);
        }
      });
    }
  } else {
    res.sendStatus(422);
  }
});

// users

router.get('/user/:id', function(req, res) {
  db.userdata.findOne({ user: req.params.id }, function(err, docs) {
    delete docs.pass; // remove password from JSON response
    res.json(docs);
  });
});

router.post('/user/register', function(req, res) {
  if (req.body.username && req.body.password) {

    db.userdata.findOne({ user: req.body.username }, function(err, docs) {
      if ( !docs ) { // if user with given username doesn't exist
        bcrypt.hash(req.body.password, config.saltRounds, function(err, hash) {
          db.userdata.insert({
            user: req.body.username,
            pass: hash,
            admin: false
          })
        });
        res.sendStatus(200);
      } else {
        debugMessage(format('User %s already exists', username));
        res.sendStatus(400);
      }
    })

  }
});

router.post('/user/login', function(req, res) {
  if (req.body.username && req.body.password) {

    db.userdata.findOne({ user: req.body.username }, function(err, docs) {
      bcrypt.compare(req.body.password, docs.pass, function(err, hashres) {
        if (hashres) {

          var tokenObject = {
            user: req.body.username,
            token: sessionToken = hash(
              new Date() + req.body.username
            )
          };

          db.sessions.insert(tokenObject)

          res.json(tokenObject);

        } else {
          res.sendStatus(400);
        }
      });
    })

  } else {
    res.sendStatus(400);
  }
});

// all of our routes will be prefixed with config.apiUrl
app.use(config.apiUrl, router);

app.listen(config.port);
debugMessage(format("HTTP server running on port %s", config.port));

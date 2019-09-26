const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../../config');
const error = require('../../../error');
const { User, Activity } = require('../../../db');

const router = express.Router();

const TOKEN_EXPIRES = 86400; // 1 day in seconds

/**
 * Middleware function that determines if a user is authenticated and assigns req.user to their user info from the db.
 * Auth header should be included in the 'Authorization' request header in the form of 'Bearer <TOKEN>'.
 */
const authenticated = (req, res, next) => {
  const authHeader = req.get('Authorization');
  if (!authHeader) return next(new error.Unauthorized());

  const authHead = authHeader.split(' ');
  const invalidAuthFormat = authHead.length !== 2 || authHead[0] !== 'Bearer' || authHead[1].length === 0;
  if (invalidAuthFormat) return next(new error.Unauthorized());

  const token = authHead[1];
  jwt.verify(token, config.auth.secret, (err, decoded) => {
    if (err) return next(new error.Unauthorized());

    // if the user provided a valid token, use it to deserialize the UUID to an actual user object
    User.findByUUID(decoded.uuid).then((user) => {
      if (!user) throw new error.Unauthorized();
      req.user = user;
    }).then(next).catch(next);
  });
};

/**
 * Login route. POST body should be in the format of { email, password } and returns an auth token on success.
 */
router.post('/login', (req, res, next) => {
  if (!req.body.email || req.body.email.length === 0) return next(new error.BadRequest('Email must be provided'));
  if (!req.body.password || req.body.password.length === 0) {
    return next(new error.BadRequest('Password must be provided'));
  }

  let userInfo = null;
  return User.findByEmail(req.body.email.toLowerCase()).then((user) => {
    if (!user) throw new error.UserError('Invalid email or password');
    if (user.isPending()) {
      throw new error.Unauthorized('Please activate your account. Check your email for an activation email');
    }
    if (user.isBlocked()) throw new error.Forbidden('Your account has been blocked');

    return user.verifyPassword(req.body.password).then((verified) => {
      if (!verified) throw new error.UserError('Invalid email or password');
      userInfo = user;
    }).then(() => new Promise((resolve, reject) => {
      jwt.sign({
        uuid: user.getDataValue('uuid'),
        admin: user.isAdmin(),
      }, config.auth.secret, { expiresIn: TOKEN_EXPIRES }, (err, token) => (err ? reject(err) : resolve(token)));
    }));
  }).then((token) => {
    res.json({ error: null, token });
    Activity.accountLoggedIn(userInfo.uuid);
  }).catch(next);
});

/**
 * Registration route. POST body accepts a user object (see DB schema for user, sanitize function). Returns the
 * created user on success.
 */
router.post('/register', (req, res, next) => {
  if (!req.body.user) return next(new error.BadRequest('User must be provided'));
  if (!req.body.user.password) return next(new error.BadRequest('Password must be provided'));
  if (req.body.user.password.length < 10) {
    return next(new error.BadRequest('Password should be at least 10 characters long'));
  }

  // TODO account activation via email
  const userModel = User.sanitize(req.body.user);
  userModel.state = 'ACTIVE';
  User.generateHash(req.body.user.password).then((hash) => {
    userModel.hash = hash;
    return User.create(userModel);
  }).then((user) => {
    res.json({ error: null, user: user.getPublicProfile() });
    Activity.accountCreated(user.uuid);
  }).catch(next);
});

module.exports = { router, authenticated };
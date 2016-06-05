'use strict'

var RpcClient = require('bitcoind-rpc')
var fs = require('fs')
var _ = require('lodash')
var BigNumber = require('bignumber.js')
var pify = require('pify')

exports.NAME = 'Bitcoind'
exports.SUPPORTED_MODULES = ['wallet']

var SATOSHI_FACTOR = 1e8

var rpc = null
var pluginConfig = {
  account: ''
}

// TODO: should it happen only once per run, or with each .config() call?
function initRpc () {
  var bitcoindConf = parseConf(pluginConfig.bitcoindConfigurationPath)

  var rpcConfig = {
    protocol: 'http',
    user: bitcoindConf.rpcuser,
    pass: bitcoindConf.rpcpassword
  }

  rpc = new RpcClient(rpcConfig)
}

// initialize Rpc only after 1st configuration is received
exports.config = function config (localConfig) {
  if (localConfig) _.merge(pluginConfig, localConfig)

  // initialize Rpc only after plugin is configured
  initRpc()
}

function richError (msg, name) {
  var err = new Error(msg)
  err.name = name
  return err
}

/*
 * initialize RpcClient
 */
function parseConf (confPath) {
  var conf = fs.readFileSync(confPath)
  var lines = conf.toString().split('\n')

  var res = {}
  for (var i = 0; i < lines.length; i++) {
    var keyVal = lines[i].split('=')

    // skip when value is empty
    if (!keyVal[1]) continue

    res[keyVal[0]] = keyVal[1]
  }

  return res
}

// We want a balance that includes all spends (0 conf) but only deposits that
// have at least 1 confirmation. getbalance does this for us automatically.
exports.balance = function balance (callback) {
  rpc.getBalance(pluginConfig.account, 1, function (err, result) {
    if (err) return callback(err)

    if (result.error) {
      return callback(richError(result.error, 'bitcoindError'))
    }

    callback(null, {
      BTC: Math.round(SATOSHI_FACTOR * result.result)
    })
  })
}

exports.sendBitcoins = function sendBitcoins (address, satoshis, fee, callback) {
  var confirmations = 1
  var bitcoins = (satoshis / SATOSHI_FACTOR).toFixed(8)

  console.log('bitcoins: %s', bitcoins)
  rpc.sendFrom(pluginConfig.account, address, bitcoins, confirmations, function (err, result) {
    if (err) {
      if (err.code === -6) {
        return callback(richError('Insufficient funds', 'InsufficientFunds'))
      }

      if (err instanceof Error) {
        return callback(err)
      }

      return callback(richError(err.message, 'bitcoindError'))
    }

    // is res.result === txHash ?
    callback(null, result.result)
  })
}

exports.newAddress = function newAddress (info, callback) {
  rpc.getNewAddress(function (err, result) {
    if (err) return callback(err)
    console.dir(result)
    callback(null, result.result)
  })
}

const balance = (address, confs) => pify(rpc.getReceivedByAddress(address, confs))
.then(bitcoins => new BigNumber(bitcoins).times(1e8))

const confirmedBalance = address => balance(address, 1)
const pendingBalance = address => balance(address, 0)

// This new call uses promises. We're in the process of upgrading everything.
exports.getStatus = function getStatus (toAddress, requested) {
  return confirmedBalance(toAddress)
  .then(confirmed => {
    if (confirmed.gte(requested)) return {status: 'confirmed'}

    return pendingBalance(toAddress)
    .then(pending => {
      if (pending.gte(requested)) return {status: 'published'}
      if (pending.gt(0)) return {status: 'insufficientFunds'}
      return {status: 'notSeen'}
    })
  })
}

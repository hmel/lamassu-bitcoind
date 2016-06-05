'use strict'

const RpcClient = require('bitcoind-rpc')
const fs = require('fs')
const _ = require('lodash')
const BigNumber = require('bignumber.js')
const pify = require('pify')

exports.NAME = 'Bitcoind'
exports.SUPPORTED_MODULES = ['wallet']

const SATOSHI_FACTOR = 1e8

let rpc = null
const pluginConfig = {
  account: ''
}

// TODO: should it happen only once per run, or with each .config() call?
function initRpc () {
  const bitcoindConf = parseConf(pluginConfig.bitcoindConfigurationPath)

  const rpcConfig = {
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
  const err = new Error(msg)
  err.name = name
  return err
}

/*
 * initialize RpcClient
 */
function parseConf (confPath) {
  const conf = fs.readFileSync(confPath)
  const lines = conf.toString().split('\n')

  const res = {}
  for (let i = 0; i < lines.length; i++) {
    const keyVal = lines[i].split('=')

    // skip when value is empty
    if (!keyVal[1]) continue

    res[keyVal[0]] = keyVal[1]
  }

  return res
}

// We want a balance that includes all spends (0 conf) but only deposits that
// have at least 1 confirmation. getbalance does this for us automatically.
exports.balance = function balance (callback) {
  rpc.getBalance(pluginConfig.account, 1, (err, result) => {
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
  const confirmations = 1
  const bitcoins = (satoshis / SATOSHI_FACTOR).toFixed(8)

  console.log('bitcoins: %s', bitcoins)
  rpc.sendFrom(pluginConfig.account, address, bitcoins, confirmations, (err, result) => {
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
  rpc.getNewAddress((err, result) => {
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

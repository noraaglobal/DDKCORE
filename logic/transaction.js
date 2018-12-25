let bignum = require('../helpers/bignum.js');
let ByteBuffer = require('bytebuffer');
let constants = require('../helpers/constants.js');
let crypto = require('crypto');
let exceptions = require('../helpers/exceptions.js');
let extend = require('extend');
let slots = require('../helpers/slots.js');
let sql = require('../sql/transactions.js');
let sqlAccount = require('../sql/accounts.js');
let request = require('request');
let transactionTypes = require('../helpers/transactionTypes.js');

// Private fields
let self, modules, __private = {};

/**
 * @typedef {Object} privateTypes
 * - 0: Transfer
 * - 1: Signature
 * - 2: Delegate
 * - 3: Vote
 * - 4: Multisignature
 * - 5: DApp
 * - 6: InTransfer
 * - 7: OutTransfer
 * - 8: STAKE
 */
__private.types = {};

/**
 * Main transaction logic.
 * @memberof module:transactions
 * @class
 * @classdesc Main transaction logic.
 * @param {Database} db
 * @param {Object} ed
 * @param {ZSchema} schema
 * @param {Object} genesisblock
 * @param {Account} account
 * @param {Object} logger
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} With `this` as data.
 */
// Constructor
function Transaction (db, ed, schema, genesisblock, account, logger, config, network, cb) {
	this.scope = {
		db: db,
		ed: ed,
		schema: schema,
		genesisblock: genesisblock,
		account: account,
		logger: logger,
		config: config,
		network: network
	};
	self = this;
	if (cb) {
		return setImmediate(cb, null, this);
	}
}

// Public methods
/**
 * Creates transaction:
 * - Analyzes data types
 * - calls `create` based on data type (see privateTypes)
 * - calls `calculateFee` based on data type (see privateTypes)
 * - creates signatures
 * @see privateTypes
 * @implements {sign}
 * @implements {getId}
 * @param {Object} data
 * @return {transaction} trs
 */
Transaction.prototype.create = async function (data) {
	if (!__private.types[data.type]) {
		throw 'Unknown transaction type ' + data.type;
	}

	if (!data.sender) {
		throw 'Invalid sender';
	}

	if (!data.keypair) {
		throw 'Invalid keypair';
	}

	let trs = {
		type: data.type,
		amount: 0,
		senderPublicKey: data.sender.publicKey,
		requesterPublicKey: data.requester ? data.requester.publicKey.toString('hex') : null,
		timestamp: slots.getTime(),
		asset: {},
		stakedAmount: 0,
		trsName: 'NA',
		groupBonus:0,
		reward: data.rewardPercentage || null
	};

	trs = await __private.types[trs.type].create.call(this, data, trs);
	trs.signature = this.sign(data.keypair, trs);

	if (data.sender.secondSignature && data.secondKeypair) {
		trs.signSignature = this.sign(data.secondKeypair, trs);
	}

	trs.id = this.getId(trs);
	trs.fee = __private.types[trs.type].calculateFee.call(this, trs, data.sender) || 0;

	return trs;
};

/**
 * Sets private type based on type id after instance object validation.
 * @param {number} typeId
 * @param {Object} instance
 * @return {Object} instance
 * @throws {string} Invalid instance interface if validations are wrong
 */
Transaction.prototype.attachAssetType = function (typeId, instance) {
	this.scope.logger.info('typeID : '+typeId);
	if (instance && typeof instance.create === 'function' && typeof instance.getBytes === 'function' &&
		typeof instance.calculateFee === 'function' && typeof instance.verify === 'function' &&
		typeof instance.objectNormalize === 'function' && typeof instance.dbRead === 'function' &&
		typeof instance.apply === 'function' && typeof instance.undo === 'function' &&
		typeof instance.applyUnconfirmed === 'function' && typeof instance.undoUnconfirmed === 'function' &&
		typeof instance.ready === 'function' && typeof instance.process === 'function'
	) {
		this.scope.logger.info('asset type is attached successfully');
		__private.types[typeId] = instance;
		return instance;
	} else {
		this.scope.logger.info('error while attaching asset type');
		throw 'Invalid instance interface';
	}
};

/**
 * Creates a signature
 * @implements {getHash}
 * @implements {scope.ed.sign}
 * @param {Object} keypair - Constains privateKey and publicKey
 * @param {transaction} trs
 * @return {signature} sign
 */
Transaction.prototype.sign = function (keypair, trs) {
	let hash = this.getHash(trs);
	return self.scope.ed.sign(hash, keypair).toString('hex');
};

/**
 * Creates a signature based on multiple signatures
 * @implements {getBytes}
 * @implements {crypto.createHash}
 * @implements {scope.ed.sign}
 * @param {Object} keypair - Constains privateKey and publicKey
 * @param {transaction} trs
 * @return {signature} sign
 */
Transaction.prototype.multisign = function (keypair, trs) {
	let bytes = this.getBytes(trs, true, true);
	let hash = crypto.createHash('sha256').update(bytes).digest();
	return this.scope.ed.sign(hash, keypair).toString('hex');
};

/**
 * Calculates transaction id based on transaction
 * @implements {bignum}
 * @implements {getHash}
 * @param {transaction} trs
 * @return {string} id
 */
Transaction.prototype.getId = function (trs) {
  return this.getHash(trs).toString('hex');
};

/**
 * Creates hash based on transaction bytes.
 * @implements {getBytes}
 * @implements {crypto.createHash}
 * @param {transaction} trs
 * @return {hash} sha256 crypto hash
 */
Transaction.prototype.getHash = function (trs) {
	return crypto.createHash('sha256').update(this.getBytes(trs)).digest();
};

/**
 * Calls `getBytes` based on trs type (see privateTypes)
 * @see privateTypes
 * @implements {ByteBuffer}
 * @param {transaction} trs
 * @param {boolean} skipSignature
 * @param {boolean} skipSecondSignature
 * @return {!Array} Contents as an ArrayBuffer.
 * @throws {error} If buffer fails.
 */
Transaction.prototype.getBytes = function (trs, skipSignature, skipSecondSignature) {
	if (!__private.types[trs.type]) {
		throw 'Unknown transaction type ' + trs.type;
	}

	let bb;

	try {
		let assetBytes = __private.types[trs.type].getBytes.call(this, trs, skipSignature, skipSecondSignature);
		let assetSize = assetBytes ? assetBytes.length : 0;
		let i;

		bb = new ByteBuffer(1 + 4 + 32 + 32 + 8 + 8 + 64 + 64 + assetSize, true);
		bb.writeByte(trs.type);
		bb.writeInt(trs.timestamp);

		let senderPublicKeyBuffer = Buffer.from(trs.senderPublicKey, 'hex');
		for (i = 0; i < senderPublicKeyBuffer.length; i++) {
			bb.writeByte(senderPublicKeyBuffer[i]);
		}

		if (trs.requesterPublicKey) {
			let requesterPublicKey = Buffer.from(trs.requesterPublicKey, 'hex');
			for (i = 0; i < requesterPublicKey.length; i++) {
				bb.writeByte(requesterPublicKey[i]);
			}
		}

		if (trs.recipientId) {
			let recipient = trs.recipientId.slice(3);
			recipient = new bignum(recipient).toBuffer({size: 8});

			for (i = 0; i < 8; i++) {
				bb.writeByte(recipient[i] || 0);
			}
		} else {
			for (i = 0; i < 8; i++) {
				bb.writeByte(0);
			}
		}

		bb.writeLong(trs.amount);

		if (assetSize > 0) {
			for (i = 0; i < assetSize; i++) {
				bb.writeByte(assetBytes[i]);
			}
		}

		if (!skipSignature && trs.signature) {
			let signatureBuffer = Buffer.from(trs.signature, 'hex');
			for (i = 0; i < signatureBuffer.length; i++) {
				bb.writeByte(signatureBuffer[i]);
			}
		}

		if (!skipSecondSignature && trs.signSignature) {
			let signSignatureBuffer = Buffer.from(trs.signSignature, 'hex');
			for (i = 0; i < signSignatureBuffer.length; i++) {
				bb.writeByte(signSignatureBuffer[i]);
			}
		}

		bb.flip();
	} catch (e) {
		throw e;
	}

	return bb.toBuffer();
};

/**
 * Calls `ready` based on trs type (see privateTypes)
 * @see privateTypes
 * @param {transaction} trs
 * @param {account} sender
 * @return {function|boolean} calls `ready` | false
 */
Transaction.prototype.ready = function (trs, sender) {
	if (!__private.types[trs.type]) {
		throw 'Unknown transaction type ' + trs.type;
	}

	if (!sender) {
		return false;
	}

	return __private.types[trs.type].ready.call(this, trs, sender);
};

/**
 * Counts transactions from `trs` table by id
 * @param {transaction} trs
 * @param {function} cb
 * @return {setImmediateCallback} error | row.count
 */
Transaction.prototype.countById = function (trs, cb) {
	this.scope.db.one(sql.countById, { id: trs.id }).then(function (row) {
		return setImmediate(cb, null, row.count);
	}).catch(function (err) {
		this.scope.logger.error(err.stack);
		return setImmediate(cb, 'Transaction#countById error');
	});
};

/**
 * @implements {countById}
 * @param {transaction} trs
 * @param {function} cb
 * @return {setImmediateCallback} error | cb
 */
Transaction.prototype.checkConfirmed = function (trs, cb) {
	this.countById(trs, function (err, count) {
		if (err) {
			return setImmediate(cb, err);
		} else if (count > 0) {
			return setImmediate(cb, 'Transaction is already confirmed: ' + trs.id);
		} else {
			return setImmediate(cb);
		}
	});
};

/**
 * Checks if balance is less than amount for sender.
 * @implements {bignum}
 * @param {number} amount
 * @param {number} balance
 * @param {transaction} trs
 * @param {account} sender
 * @returns {Object} With exceeded boolean and error: address, balance
 *  modify checkbalance according to froze amount avaliable to user
 */
Transaction.prototype.checkBalance = function (amount, balance, trs, sender) {

	let totalAmountWithFrozeAmount = trs.type === transactionTypes.SENDSTAKE ?
		new bignum(amount)
		:
		new bignum(sender.totalFrozeAmount).plus(amount);

	let exceededBalance = new bignum(sender[balance].toString()).lessThan(totalAmountWithFrozeAmount);
	let exceeded = (trs.blockId !== this.scope.genesisblock.block.id && exceededBalance);

	// FIXME
  // https://trello.com/c/MPx5yxNH/134-account-does-not-have-enough-ddk
  if (trs.height <= constants.MASTER_NODE_MIGRATED_BLOCK) {
    exceeded = false;
  }

	if (parseInt(sender.totalFrozeAmount) > 0) {
		return {
			exceeded: exceeded,
			error: exceeded ? [
				'Account does not have enough DDK due to freeze amount:', sender.address,
				'balance:', new bignum(sender[balance].toString() || '0').div(Math.pow(10, 8)),
				'totalFreezeAmount :', new bignum(sender.totalFrozeAmount.toString()).div(Math.pow(10, 8))
			].join(' ') : null
		};
	} else {
		return {
			exceeded: exceeded,
			error: exceeded ? [
				'Account does not have enough DDK:', sender.address,
				'balance:', new bignum(sender[balance].toString() || '0').div(Math.pow(10, 8))
			].join(' ') : null
		};
	}

};

/**
 * Validates parameters.
 * Calls `process` based on trs type (see privateTypes)
 * @see privateTypes
 * @implements {getId}
 * @param {transaction} trs
 * @param {account} sender
 * @param {account} requester
 * @param {function} cb
 * @return {setImmediateCallback} validation errors | trs
 */
Transaction.prototype.process = function (trs, sender, requester, cb) {
	if (typeof requester === 'function') {
		cb = requester;
	}

	// Check transaction type
	if (!__private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	// if (!this.ready(trs, sender)) {
	// 	return setImmediate(cb, 'Transaction is not ready: ' + trs.id);
	// }

	// Check sender
	if (!sender) {
		return setImmediate(cb, 'Missing sender');
	}

	// Get transaction id
	let txId;

	try {
		txId = this.getId(trs);
	} catch (e) {
		this.scope.logger.error(e.stack);
		return setImmediate(cb, 'Failed to get transaction id');
	}

	// Check transaction id
	if (trs.id && trs.id !== txId) {
		return setImmediate(cb, 'Invalid transaction id');
	} else {
		trs.id = txId;
	}

	// Equalize sender address
	trs.senderId = sender.address;

	// Call process on transaction type
	__private.types[trs.type].process.call(this, trs, sender, function (err, trs) {
		if (err) {
			return setImmediate(cb, err);
		} else {
			return setImmediate(cb, null, trs);
		}
	}.bind(this));
};

Transaction.prototype.getAccountStatus = function(trs, cb) {
	this.scope.db.one(sqlAccount.checkAccountStatus, {
		senderId: trs.senderId
	}).then(function (row) {
		if (row.status === 0) {
			return setImmediate(cb,'Invalid transaction : account disabled');
		}
		return setImmediate(cb, null, row.status);
	}).catch(function (err) {
		this.scope.logger.error(err.stack);
		return setImmediate(cb, 'Transaction#checkAccountStatus error');
	});
};

/**
 * Validates parameters.
 * Calls `process` based on trs type (see privateTypes)
 * @see privateTypes
 * @implements {getId}
 * @param {transaction} trs
 * @param {account} sender
 * @param {account} requester
 * @param  {boolean} checkExists - Check if transaction already exists in database
 * @param {function} cb
 * @return {setImmediateCallback} validation errors | trs
 */
Transaction.prototype.verify = function (trs, sender, requester = {}, checkExists, cb) {
	let valid = false;
	let err = null;
    if (typeof checkExists === 'function') {
        cb = checkExists;
        checkExists = false;
    } else if (typeof requester === 'function') {
		cb = requester;
        requester = {};
	}
	// Check sender
	if (!sender) {
		return setImmediate(cb, 'Missing sender');
	}

	// Check transaction type
	if (!__private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	// Check for missing sender second signature
	if (!trs.requesterPublicKey && sender.secondSignature && !trs.signSignature && trs.blockId !== this.scope.genesisblock.block.id) {
		return setImmediate(cb, 'Missing sender second signature');
	}

	// If second signature provided, check if sender has one enabled
	if (!trs.requesterPublicKey && !sender.secondSignature && (trs.signSignature && trs.signSignature.length > 0)) {
		return setImmediate(cb, 'Sender does not have a second signature');
	}

	// Check for missing requester second signature
	if (trs.requesterPublicKey && requester.secondSignature && !trs.signSignature) {
		return setImmediate(cb, 'Missing requester second signature');
	}

	// If second signature provided, check if requester has one enabled
	if (trs.requesterPublicKey && !requester.secondSignature && (trs.signSignature && trs.signSignature.length > 0)) {
		return setImmediate(cb, 'Requester does not have a second signature');
	}

	// Check sender public key
	if (sender.publicKey && sender.publicKey !== trs.senderPublicKey) {
		err = ['Invalid sender public key:', trs.senderPublicKey, 'expected:', sender.publicKey].join(' ');

		if (exceptions.senderPublicKey.indexOf(trs.id) > -1) {
			this.scope.logger.debug(err);
			this.scope.logger.debug(JSON.stringify(trs));
		} else {
			return setImmediate(cb, err);
		}
	}

	// Check sender is not genesis account unless block id equals genesis
	if ([exceptions.genesisPublicKey.mainnet, exceptions.genesisPublicKey.testnet].indexOf(sender.publicKey) !== -1 && trs.blockId !== this.scope.genesisblock.block.id) {
		return setImmediate(cb, 'Invalid sender. Can not send from genesis account');
	}

	// Check sender address
	if (String(trs.senderId).toUpperCase() !== String(sender.address).toUpperCase()) {
		return setImmediate(cb, 'Invalid sender address');
	}

	// Determine multisignatures from sender or transaction asset
	let multisignatures = sender.multisignatures || sender.u_multisignatures || [];
	if (multisignatures.length === 0) {
		if (trs.asset && trs.asset.multisignature && trs.asset.multisignature.keysgroup) {

			for (let i = 0; i < trs.asset.multisignature.keysgroup.length; i++) {
				let key = trs.asset.multisignature.keysgroup[i];

				if (!key || typeof key !== 'string') {
					return setImmediate(cb, 'Invalid member in keysgroup');
				}

				multisignatures.push(key.slice(1));
			}
		}
	}

	// Check requester public key
	if (trs.requesterPublicKey) {
		multisignatures.push(trs.senderPublicKey);

		if (sender.multisignatures.indexOf(trs.requesterPublicKey) < 0) {
			return setImmediate(cb, 'Account does not belong to multisignature group');
		}
	}

	// Verify signature
	try {
		valid = false;
		valid = this.verifySignature(trs, (trs.requesterPublicKey || trs.senderPublicKey), trs.signature);
	} catch (e) {
		this.scope.logger.error(e.stack);
		return setImmediate(cb, e.toString());
	}

	if (!valid) {
		err = 'Failed to verify signature';

		if (exceptions.signatures.indexOf(trs.id) > -1) {
			this.scope.logger.debug(err);
			this.scope.logger.debug(JSON.stringify(trs));
			valid = true;
			err = null;
		} else {
			return setImmediate(cb, err);
		}
	}

	// Verify second signature
	if (requester.secondSignature || sender.secondSignature) {
		try {
			valid = false;
			valid = this.verifySecondSignature(trs, (requester.secondPublicKey || sender.secondPublicKey), trs.signSignature);
		} catch (e) {
			return setImmediate(cb, e.toString());
		}

		if (!valid) {
			return setImmediate(cb, 'Failed to verify second signature');
		}
	}

	// Check that signatures are unique
	if (trs.signatures && trs.signatures.length) {
		let signatures = trs.signatures.reduce(function (p, c) {
			if (p.indexOf(c) < 0) { p.push(c); }
			return p;
		}, []);

		if (signatures.length !== trs.signatures.length) {
			return setImmediate(cb, 'Encountered duplicate signature in transaction');
		}
	}

	// Verify multisignatures
	if (trs.signatures) {
		for (let d = 0; d < trs.signatures.length; d++) {
			valid = false;

			for (let s = 0; s < multisignatures.length; s++) {
				if (trs.requesterPublicKey && multisignatures[s] === trs.requesterPublicKey) {
					continue;
				}

				if (this.verifySignature(trs, multisignatures[s], trs.signatures[d])) {
					valid = true;
				}
			}

			if (!valid) {
				return setImmediate(cb, 'Failed to verify multisignature');
			}
		}
	}

	let fee = __private.types[trs.type].calculateFee.call(this, trs, sender) || 0;
	if (
		(trs.type !== transactionTypes.MIGRATION && trs.type !== transactionTypes.REFERRAL) &&
		!(trs.type === transactionTypes.STAKE && trs.stakedAmount < 0) &&
		(!fee || trs.fee !== fee)
	) {
		return setImmediate(cb, 'Invalid transaction fee');
	}

	// Check amount
	if (trs.amount < 0 || trs.amount > constants.totalAmount || String(trs.amount).indexOf('.') >= 0 || trs.amount.toString().indexOf('e') >= 0 ) {
		return setImmediate(cb, 'Invalid transaction amount');
	}

	// //Check sender not able to do transaction on froze amount
	let amount;
	// Check confirmed sender balance
	if (trs.type !== transactionTypes.MIGRATION) {
		amount = new bignum(trs.amount.toString()).plus(trs.fee.toString());
	} else {
		amount = new bignum(trs.amount.toString());
	}

	let senderBalance = this.checkBalance(amount, 'balance', trs, sender);

	if (senderBalance.exceeded) {
		return setImmediate(cb, senderBalance.error);
	}

	// Check timestamp
	if (slots.getSlotNumber(trs.timestamp) > slots.getSlotNumber()) {
		return setImmediate(cb, 'Invalid transaction timestamp. Timestamp is in the future');
	}

    const verifyTransactionTypes = (transaction, sender, verifyTransactionTypesCb) => {
		__private.types[trs.type].verify.call(this, transaction, sender, function (err) {
            if (err) {
                return setImmediate(verifyTransactionTypesCb, err);
            }
            return setImmediate(verifyTransactionTypesCb);
        });
    };

    if (checkExists) {
		this.checkConfirmed(trs, (checkConfirmedErr, isConfirmed) => {
            if (checkConfirmedErr) {
                return setImmediate(cb, checkConfirmedErr);
            }

            if (isConfirmed) {
                return setImmediate(
                    cb,
					`Transaction is already confirmed: ${trs.id}`
                );
            }

			verifyTransactionTypes(trs, sender, cb);
        });
    } else {
		verifyTransactionTypes(trs, sender, cb);
    }
};

/**
 * Verifies signature for valid transaction type
 * @implements {getBytes}
 * @implements {verifyBytes}
 * @param {transaction} trs
 * @param {publicKey} publicKey
 * @param {signature} signature
 * @return {boolean}
 * @throws {error}
 */
Transaction.prototype.verifySignature = function (trs, publicKey, signature) {
	if (!__private.types[trs.type]) {
		throw 'Unknown transaction type ' + trs.type;
	}

	if (!signature) { return false; }

	let res;

	try {
		let bytes = this.getBytes(trs, true, true);
		res = this.verifyBytes(bytes, publicKey, signature);
	} catch (e) {
		throw e;
	}

	return res;
};

/**
 * Verifies second signature for valid transaction type
 * @implements {getBytes}
 * @implements {verifyBytes}
 * @param {transaction} trs
 * @param {publicKey} publicKey
 * @param {signature} signature
 * @return {boolean}
 * @throws {error}
 */
Transaction.prototype.verifySecondSignature = function (trs, publicKey, signature) {
	if (!__private.types[trs.type]) {
		throw 'Unknown transaction type ' + trs.type;
	}

	if (!signature) { return false; }

	let res;

	try {
		let bytes = this.getBytes(trs, false, true);
		res = this.verifyBytes(bytes, publicKey, signature);
	} catch (e) {
		throw e;
	}

	return res;
};

/**
 * Verifies hash, publicKey and signature.
 * @implements {crypto.createHash}
 * @implements {scope.ed.verify}
 * @param {Array} bytes
 * @param {publicKey} publicKey
 * @param {signature} signature
 * @return {boolean} verified hash, signature and publicKey
 * @throws {error}
 */
Transaction.prototype.verifyBytes = function (bytes, publicKey, signature) {
	let res;

	try {
		let data2 = Buffer.alloc(bytes.length);

		for (let i = 0; i < data2.length; i++) {
			data2[i] = bytes[i];
		}

		let hash = crypto.createHash('sha256').update(data2).digest();
		let signatureBuffer = Buffer.from(signature, 'hex');
		let publicKeyBuffer = Buffer.from(publicKey, 'hex');

		res = this.scope.ed.verify(hash, signatureBuffer || ' ', publicKeyBuffer || ' ');
	} catch (e) {
		throw e;
	}

	return res;
};

/**
 * Merges account into sender address, Calls `apply` based on trs type (privateTypes).
 * @see privateTypes
 * @implements {checkBalance}
 * @implements {account.merge}
 * @implements {modules.rounds.calc}
 * @param {transaction} trs
 * @param {block} block
 * @param {account} sender
 * @param {function} cb - Callback function
 * @return {setImmediateCallback} for errors | cb
 */
Transaction.prototype.apply = function (trs, block, sender, cb) {
	if (!this.ready(trs, sender)) {
		return setImmediate(cb, 'Transaction is not ready');
	}

	let amount;
	// Check confirmed sender balance
	if (trs.type !== transactionTypes.MIGRATION) {
		amount = new bignum(trs.amount.toString()).plus(trs.fee.toString());
	} else {
		amount = new bignum(trs.amount.toString());
	}
	let senderBalance = this.checkBalance(amount, 'balance', trs, sender);

	if (senderBalance.exceeded) {
		return setImmediate(cb, senderBalance.error);
	}

	amount = amount.toNumber();

	this.scope.logger.trace('Logic/Transaction->apply', {sender: sender.address, balance: -amount, blockId: block.id, round: modules.rounds.calc(block.height)});
	this.scope.account.merge(sender.address, {
		balance: -amount,
		blockId: block.id,
		round: modules.rounds.calc(block.height)
	}, function (err, sender) {
		if (err) {
			return setImmediate(cb, err);
		}
		/**
		 * calls apply for Transfer, Signature, Delegate, Vote, Multisignature,
		 * DApp, InTransfer or OutTransfer.
		 */
		__private.types[trs.type].apply.call(this, trs, block, sender, function (err) {
			if (err) {
				this.scope.account.merge(sender.address, {
					balance: amount,
					blockId: block.id,
					round: modules.rounds.calc(block.height)
				}, function (err) {
					return setImmediate(cb, err);
				});
			} else {
				return setImmediate(cb);
			}
		}.bind(this));
	}.bind(this));
};

/**
 * Merges account into sender address, Calls `undo` based on trs type (privateTypes).
 * @see privateTypes
 * @implements {bignum}
 * @implements {account.merge}
 * @implements {modules.rounds.calc}
 * @param {transaction} trs
 * @param {block} block
 * @param {account} sender
 * @param {function} cb - Callback function
 * @return {setImmediateCallback} for errors | cb
 */
Transaction.prototype.undo = function (trs, block, sender, cb) {
	let amount = new bignum(trs.amount.toString());
	if (trs.type !== transactionTypes.MIGRATION) {
		amount = amount.plus(trs.fee.toString()).toNumber();
	}

	this.scope.logger.trace('Logic/Transaction->undo', {sender: sender.address, balance: amount, blockId: block.id, round: modules.rounds.calc(block.height)});
	this.scope.account.merge(sender.address, {
		balance: amount,
		blockId: block.id,
		round: modules.rounds.calc(block.height)
	}, function (err, sender) {
		if (err) {
			return setImmediate(cb, err);
		}

		__private.types[trs.type].undo.call(this, trs, block, sender, function (err) {
			if (err) {
				this.scope.account.merge(sender.address, {
					balance: -amount,
					blockId: block.id,
					round: modules.rounds.calc(block.height)
				}, function (err) {
					return setImmediate(cb, err);
				});
			} else {
				return setImmediate(cb);
			}
		}.bind(this));
	}.bind(this));
};

/**
 * Checks unconfirmed sender balance. Merges account into sender address with
 * unconfirmed balance negative amount.
 * Calls `applyUnconfirmed` based on trs type (privateTypes). If error merge
 * account with amount.
 * @see privateTypes
 * @implements {bignum}
 * @implements {checkBalance}
 * @implements {account.merge}
 * @param {transaction} trs
 * @param {account} sender
 * @param {account} requester
 * @param {function} cb - Callback function
 * @return {setImmediateCallback} for errors | cb
 */
Transaction.prototype.applyUnconfirmed = function (trs, sender, requester, cb) {
	if (typeof requester === 'function') {
		cb = requester;
	}
	var amount;
	// Check unconfirmed sender balance
	if (trs.type === transactionTypes.MIGRATION) {
		amount = new bignum(trs.amount.toString());
	} else {
		amount = new bignum(trs.amount.toString()).plus(trs.fee.toString());
	}
    if(trs.type == transactionTypes.STAKE && (parseInt(sender.u_balance) - parseInt(sender.u_totalFrozeAmount)) < (trs.stakedAmount + trs.fee)){
        return setImmediate(cb, 'Failed because of Frozen DDK');
    }
	let senderBalance = this.checkBalance(amount, 'u_balance', trs, sender);

	if (senderBalance.exceeded) {
		return setImmediate(cb, senderBalance.error);
	}

	amount = amount.toNumber();


    if (trs.type == transactionTypes.STAKE) {
        this.scope.account.merge(sender.address, {u_balance: -amount, u_totalFrozeAmount: trs.stakedAmount }, function (err, sender) {
            if (err) {
                return setImmediate(cb, err);
            }

            __private.types[trs.type].applyUnconfirmed.call(this, trs, sender, function (err) {
                if (err) {
                    this.scope.account.merge(sender.address, {u_balance: amount, u_totalFrozeAmount: -trs.stakedAmount }, function (err2) {
                        return setImmediate(cb, err2 || err);
                    });
                } else {
                    return setImmediate(cb);
                }
            }.bind(this));
        }.bind(this));
    } else {
        this.scope.account.merge(sender.address, { u_balance: -amount }, function (err, sender) {
            if (err) {
                return setImmediate(cb, err);
            }

            __private.types[trs.type].applyUnconfirmed.call(this, trs, sender, function (err) {
                if (err) {
                    this.scope.account.merge(sender.address, { u_balance: amount }, function (err2) {
                        return setImmediate(cb, err2 || err);
                    });
                } else {
                    return setImmediate(cb);
                }
            }.bind(this));
        }.bind(this));
    }

};

/**
 * Merges account into sender address with unconfirmed balance trs amount.
 * Calls `undoUnconfirmed` based on trs type (privateTypes). If error merge
 * account with megative amount.
 * @see privateTypes
 * @implements {bignum}
 * @implements {account.merge}
 * @param {transaction} trs
 * @param {account} sender
 * @param {function} cb - Callback function
 * @return {setImmediateCallback} for errors | cb
 */
Transaction.prototype.undoUnconfirmed = function (trs, sender, cb) {
	let amount = new bignum(trs.amount.toString());
	if (trs.type !== transactionTypes.MIGRATION) {
		amount = amount.plus(trs.fee.toString()).toNumber();
	}
	else {
		amount = amount.toNumber();
	}

    if(trs.type == transactionTypes.STAKE){
        this.scope.account.merge(sender.address, {u_balance: amount, u_totalFrozeAmount: -trs.stakedAmount}, function (err, sender) {
            if (err) {
                return setImmediate(cb, err);
            }

            __private.types[trs.type].undoUnconfirmed.call(this, trs, sender, function (err) {
                if (err) {
                    this.scope.account.merge(sender.address, {u_balance: -amount, u_totalFrozeAmount: trs.stakedAmount}, function (err2) {
                        return setImmediate(cb, err2 || err);
                    });
                } else {
                    return setImmediate(cb);
                }
            }.bind(this));
        }.bind(this));
    }else{
        this.scope.account.merge(sender.address, {u_balance: amount}, function (err, sender) {
            if (err) {
                return setImmediate(cb, err);
            }

            __private.types[trs.type].undoUnconfirmed.call(this, trs, sender, function (err) {
                if (err) {
                    this.scope.account.merge(sender.address, {u_balance: -amount}, function (err2) {
                        return setImmediate(cb, err2 || err);
                    });
                } else {
                    return setImmediate(cb);
                }
            }.bind(this));
        }.bind(this));
    }
};

Transaction.prototype.dbTable = 'trs';

Transaction.prototype.dbFields = [
	'id',
	'blockId',
	'type',
	'timestamp',
	'senderPublicKey',
	'requesterPublicKey',
	'senderId',
	'recipientId',
	'amount',
	'stakedAmount',
	'stakeId',
	'groupBonus',
	'fee',
	'signature',
	'signSignature',
	'signatures',
	'trsName',
	'reward'
];

/**
 * Creates db trs object transaction. Calls `dbSave` based on trs type (privateTypes).
 * @see privateTypes
 * @param {transaction} trs
 * @return {Object[]} dbSave result + created object
 * @throws {String|error} error string | catch error
 */
Transaction.prototype.dbSave = function (trs) {
	if (!__private.types[trs.type]) {
		throw 'Unknown transaction type ' + trs.type;
	}

	let senderPublicKey, signature, signSignature, requesterPublicKey;

	try {
		senderPublicKey = Buffer.from(trs.senderPublicKey, 'hex');
		signature = Buffer.from(trs.signature, 'hex');
		signSignature = trs.signSignature ? Buffer.from(trs.signSignature, 'hex') : null;
		requesterPublicKey = trs.requesterPublicKey ? Buffer.from(trs.requesterPublicKey, 'hex') : null;
	} catch (e) {
		throw e;
	}

	// FIXME ?
	if((trs.type === transactionTypes.STAKE) && trs.freezedAmount > 0){
		trs.amount = trs.freezedAmount;
	}

	if (trs.type === transactionTypes.MIGRATION) {
		trs.fee = 0;
	}

	let promises = [
		{
			table: this.dbTable,
			fields: this.dbFields,
			values: {
				id: trs.id,
				blockId: trs.blockId,
				type: trs.type,
				timestamp: trs.timestamp,
				senderPublicKey: senderPublicKey,
				requesterPublicKey: requesterPublicKey,
				senderId: trs.senderId,
				recipientId: trs.recipientId || null,
				amount: trs.amount,
				stakedAmount: trs.stakedAmount,
				stakeId: trs.stakeId || null,
				groupBonus: trs.groupBonus,
				fee: trs.fee,
				signature: signature,
				signSignature: signSignature,
				signatures: trs.signatures ? trs.signatures.join(',') : null,
				trsName: trs.trsName,
				reward: trs.reward
			}
		}
	];

	let promise = __private.types[trs.type].dbSave(trs);

	if (promise) {
		promises.push(promise);
	}

	return promises;
};

/**
 * Calls `afterSave` based on trs type (privateTypes).
 * @see privateTypes
 * @param {transaction} trs
 * @param {function} cb
 * @return {setImmediateCallback} error string | cb
 */
Transaction.prototype.afterSave = function (trs, cb) {
	if (trs.type === transactionTypes.STAKE) {
		//Stake order event
		this.scope.network.io.sockets.emit('stake/change', null);
	}

	let tx_type = __private.types[trs.type];

	if (!tx_type) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	} else {
		if (typeof tx_type.afterSave === 'function') {
			return tx_type.afterSave.call(this, trs, cb);
		} else {
			return setImmediate(cb);
		}
	}
};

/**
 * @typedef {Object} transaction
 * @property {string} id
 * @property {number} height
 * @property {string} blockId
 * @property {number} type
 * @property {number} timestamp
 * @property {publicKey} senderPublicKey
 * @property {publicKey} requesterPublicKey
 * @property {string} senderId
 * @property {string} recipientId
 * @property {number} amount
 * @property {number} fee
 * @property {string} signature
 * @property {string} signSignature
 * @property {Object} asset
 * @property {multisignature} [asset.multisignature]
 * @property {signature} [asset.signature]
 * @property {dapp} [asset.dapp]
 * @property {Object} [asset.outTransfer] - Contains dappId and transactionId
 * @property {Object} [asset.inTransfer] - Contains dappId
 * @property {votes} [asset.votes] - Contains multiple votes to a transactionId
 *
 */
Transaction.prototype.schema = {
	id: 'Transaction',
	type: 'object',
	properties: {
		id: {
			type: 'string',
			format: 'hex',
			minLength: 1,
			maxLength: 64
		},
		height: {
			type: 'integer'
		},
		blockId: {
			type: 'string',
      format: 'hex',
      minLength: 1,
      maxLength: 64
		},
		type: {
			type: 'integer'
		},
		timestamp: {
			type: 'integer'
		},
		senderPublicKey: {
			type: 'string',
			format: 'publicKey'
		},
		requesterPublicKey: {
			type: 'string',
			format: 'publicKey'
		},
		senderId: {
			type: 'string',
			format: 'address',
			minLength: 1,
			maxLength: 25
		},
		recipientId: {
			type: 'string',
			format: 'address',
			minLength: 1,
			maxLength: 25
		},
		amount: {
			type: 'integer',
			minimum: 0,
			maximum: constants.totalAmount
		},
		fee: {
			type: 'integer',
			minimum: 0,
			maximum: constants.totalAmount
		},
		signature: {
			type: 'string',
			format: 'signature'
		},
		signSignature: {
			type: 'string',
			format: 'signature'
		},
		asset: {
			type: 'object'
		}
	},
	required: ['type', 'timestamp', 'senderPublicKey', 'signature']
};

Transaction.prototype.Referschema = {
	id: 'Transaction',
	type: 'object',
	properties: {
		id: {
			type: 'string',
      format: 'hex',
      minLength: 1,
      maxLength: 64
		},
		height: {
			type: 'integer'
		},
		blockId: {
			type: 'string',
      format: 'hex',
      minLength: 1,
      maxLength: 64
		},
		type: {
			type: 'integer'
		},
		timestamp: {
			type: 'integer'
		},
		senderPublicKey: {
			type: 'string',
			format: 'publicKey'
		},
		requesterPublicKey: {
			type: 'string',
			format: 'publicKey'
		},
		senderId: {
			type: 'string',
			format: 'address',
			minLength: 1,
			maxLength: 25
		},
		recipientId: {
			type: 'string',
			format: 'address',
			minLength: 1,
			maxLength: 25
		},
		amount: {
			type: 'integer',
			minimum: 0,
			maximum: constants.totalAmount
		},
		fee: {
			type: 'integer',
			minimum: 0,
			maximum: constants.totalAmount
		},
		signature: {
			type: 'string',
			format: 'signature'
		},
		signSignature: {
			type: 'string',
			format: 'signature'
		},
		asset: {
			type: 'object'
		}
	},
	required: ['type', 'timestamp', 'senderPublicKey', 'signature']
};

/**
 * Calls `objectNormalize` based on trs type (privateTypes).
 * @see privateTypes
 * @implements {scope.schema.validate}
 * @param {transaction} trs
 * @return {error|transaction} error string | trs normalized
 * @throws {string} error message
 */
Transaction.prototype.objectNormalize = function (trs) {
	if (!__private.types[trs.type]) {
		throw 'Unknown transaction type ' + trs.type;
	}

	for (let i in trs) {
		if (trs[i] === null || typeof trs[i] === 'undefined') {
			delete trs[i];
		}
	}
	trs.fee = trs.fee || 0;

	if (trs.type === transactionTypes.MIGRATION)
		var report = this.scope.schema.validate(trs, Transaction.prototype.Referschema);
	else
		var report = this.scope.schema.validate(trs, Transaction.prototype.schema);

	// schemaValidator
	if (!report) {
		throw 'Failed to validate transaction schema: ' + this.scope.schema.getLastErrors().map(function (err) {
			return err.message;
		}).join(', ');
	}

	try {
		trs = __private.types[trs.type].objectNormalize.call(this, trs);
	} catch (e) {
		throw e;
	}

	return trs;
};

/**
 * Calls `dbRead` based on trs type (privateTypes) to add tr asset.
 * @see privateTypes
 * @param {Object} raw
 * @return {null|tx}
 * @throws {string} Unknown transaction type
 */
Transaction.prototype.dbRead = function (raw) {
	if (!raw.t_id) {
		return null;
	} else {
		let tx = {
			id: raw.t_id,
			height: raw.b_height,
			blockId: raw.b_id || raw.t_blockId,
			type: parseInt(raw.t_type),
			timestamp: parseInt(raw.t_timestamp),
			senderPublicKey: raw.t_senderPublicKey,
			requesterPublicKey: raw.t_requesterPublicKey,
			senderId: raw.t_senderId,
			recipientId: raw.t_recipientId,
			recipientPublicKey: raw.m_recipientPublicKey || null,
			amount: parseInt(raw.t_amount),
			stakedAmount: parseInt(raw.t_stakedAmount),
			stakeId: raw.t_stakeId,
			groupBonus: parseInt(raw.t_groupBonus),
			fee: parseInt(raw.t_fee),
			signature: raw.t_signature,
			signSignature: raw.t_signSignature,
			signatures: raw.t_signatures ? raw.t_signatures.split(',') : [],
			confirmations: parseInt(raw.confirmations),
			asset: {},
			trsName: raw.t_trsName,
			reward: raw.t_reward,
			pendingGroupBonus: raw.t_pendingGroupBonus
		};

		if (!__private.types[tx.type]) {
			throw 'Unknown transaction type ' + tx.type;
		}

		let asset = __private.types[tx.type].dbRead.call(this, raw);

		if (asset) {
			tx.asset = extend(tx.asset, asset);
		}

		return tx;
	}
};

// Events
/**
 * Binds input parameters to private variables modules.
 * @param {Object} __modules
 */
Transaction.prototype.bindModules = function (__modules) {
	this.scope.logger.trace('Logic/Transaction->bindModules');
	modules = {
		rounds: __modules.rounds
	};
};

// call add transaction API
Transaction.prototype.sendTransaction = function (data, cb) {

	let port = this.scope.config.app.port;
	let address = this.scope.config.address;

	request.put('http://' + address + ':' + port + '/api/transactions/', data, function (error, transactionResponse) {
		if (error)
			return setImmediate(cb, error);

		return setImmediate(cb, null, transactionResponse);
	});
};

// Export
module.exports = Transaction;

/*************************************** END OF FILE *************************************/

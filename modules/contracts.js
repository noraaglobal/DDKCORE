/********************************************************************************
 * Added By Hotam Singh
 * 
 *******************************************************************************/

//Requiring Modules 
var Contract = require('../logic/contract.js');
var transactionTypes = require('../helpers/transactionTypes.js');
var sql = require('../sql/frogings.js');
var config = require('../config.json');
var contributorsStatus = true;

//Private Fields
var __private = {}, self = null,
library = null, modules = null;
__private.assetTypes = {};

//Contracts Constuctor Initialized from app.js
function Contracts(cb, scope) {
    library = {
		logger: scope.logger,
		sequence: scope.sequence,
		ed: scope.ed,
		db: scope.db,
		network: scope.network,
		schema: scope.schema,
		balancesSequence: scope.balancesSequence,
		logic: {
			transaction: scope.logic.transaction,
			contract: scope.logic.contract
		},
		config: {
			forging: {
				secret: scope.config.forging.secret,
				access: {
					whiteList: scope.config.forging.access.whiteList,
				},
			},
		},
    };
    
    self = this;
    self.type = transactionTypes.CONTRACT;

    __private.assetTypes[transactionTypes.CONTRACT] = library.logic.transaction.attachAssetType(
		transactionTypes.CONTRACT, new Contract()
	);
    
    setImmediate(cb, null, self);
};

//Running Smart Contract
Contracts.prototype.onNewBlock = function (block, broadcast, cb) {
	if(block.height == 2) {
		config.contributors.startTime = block.timestamp;
		var date = new Date(block.timestamp * 1000);
		config.contributors.endTime = (date.setMinutes(date.getMinutes() + 5))/1000;
		var contributors = config.contributors.users;
		library.logic.contract.sendToContrubutors(contributors);
		contributors.forEach(function(senderId) {
			library.db.none(sql.disableAccount, { 
				senderId: senderId 
			}).then(function () {	   
				library.logger.info(senderId + ' account is locked for ' + config.contributors.lockTime +' months');	
			}).catch(function (err) {		 
				library.logger.error(err.stack);			
			});
		});
	}

	//Unlock contributor's account after 3 months(currently 5 minutes) 
	if(block.timestamp == config.contributors.endTime) {
		var contributors = config.contributors.users;
		contributors.forEach(function(senderId) {
			library.db.none(sql.enableAccount, { 
				senderId: senderId 
			}).then(function () {	   
				library.logger.info(senderId + ' account is unlocked for ' + config.contributors.lockTime +' months');	
			}).catch(function (err) {		 
				library.logger.error(err.stack);			
			});
		});
	}
};

//OnBInd Event called from app.js
Contracts.prototype.onBind = function (scope) {
    modules = {
		loader: scope.loader,
		rounds: scope.rounds,
		accounts: scope.accounts,
		blocks: scope.blocks,
		transport: scope.transport,
		transactions: scope.transactions,
		delegates: scope.delegates,
    };
    __private.assetTypes[transactionTypes.CONTRACT].bind(
		scope.accounts, scope.logger
	);
}

module.exports = Contracts;
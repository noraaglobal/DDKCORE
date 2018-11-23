const { createServerRPCMethod } = require('./../util');


module.exports = createServerRPCMethod(

  'GET_FEES',

  /**
   * @param {WebSocketServer} wss
   * @param {object} params
   * @param {object} scope - Application instance
   * @param {function} cdError - Application Error callback
   */
  function (wss, params, scope, cdError) {
    return new Promise(function (resolve) {
      scope.modules.blocks.submodules.api.getFees({body: params}, (error, result) => {

        resolve(error
          ? {error}
          : result);
      });
    });
  });
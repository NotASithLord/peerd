// @ts-check

/**
 * Report only the demonstrated Chrome boundary. A direct top-level navigation
 * may preconnect before DNR refuses its HTTP request; every other vector keeps
 * its zero-transport assertion. Missing probe execution is never a pass.
 * @param {{check:(name:string,pass:boolean,detail:string)=>void}} rec
 * @param {string} vector
 * @param {{attempted:boolean,connections:number,requests:string[]}} observed
 */
export const recordNetworkFloorVector = (rec, vector, observed) => {
  rec.check(`${vector} probe executed`, observed.attempted === true, JSON.stringify(observed));
  if (vector === 'location') {
    rec.check('location sends no private HTTP request', observed.requests.length === 0,
      JSON.stringify({
        ...observed,
        mode: observed.requests.length > 0 ? 'http-request-observed'
          : observed.connections === 0 ? 'blocked-before-connect' : 'connected-without-request',
      }));
  } else {
    rec.check(`${vector} causes no private TCP or HTTP side effect`,
      observed.connections === 0 && observed.requests.length === 0, JSON.stringify(observed));
  }
};

const { mkdirp } = require('mkdirp');

const path = require('path');
const fs = require('fs').promises;


/**
 * This component adds the #onActive method to subscribe to events
 * for explicitly activated repositories only.
 *
 * @constructor
 *
 * @param {import('../types').Logger} logger
 * @param {import('./webhook-events/WebhookEvents')} webhookEvents
 */
function LogEvents(logger, webhookEvents) {

  if (process.env.NODE_ENV !== 'development' && !process.env.LOG_WEBHOOK_EVENTS) {
    return;
  }

  const log = logger.child({
    name: 'wuffle:log-events'
  });

  const eventsDir = 'tmp/events';

  let counter = 0;

  log.info('dumping webhook events to %s', path.resolve(eventsDir));

  function write(event, payload) {

    const {
      action
    } = payload;

    const name = action ? `${event}.${action}` : event;

    const data = JSON.stringify({ event, payload }, null, '  ');

    return mkdirp(eventsDir).then(() => {
      const fileName = path.join(eventsDir, `${Date.now()}-${counter++}-${name}.json`);

      return fs.writeFile(fileName, data, 'utf8');
    });
  }


  // behavior //////////////////////

  webhookEvents.onAny(async context => {
    const {
      name,
      payload
    } = context;

    write(name, payload).catch(err => {
      log.error(err, 'failed to log event');
    });
  });

}

module.exports = LogEvents;
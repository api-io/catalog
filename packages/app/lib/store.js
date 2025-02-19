const {
  groupBy
} = require('min-dash');

const pDefer = require('p-defer');

const {
  issueIdent
} = require('./util');

const {
  findLinks
} = require('./util/links');

const { Links } = require('./links');


/**
 * The store that holds all board data
 * and makes it accessible.
 */
class Store {

  /**
   * @param {import('./columns')} columns
   * @param {import('./types').Logger} logger
   * @param {import('./events')} events
   *
   * @constructor
   */
  constructor(columns, logger, events) {
    this.log = logger.child({
      name: 'wuffle:store'
    });

    this.columns = columns;
    this.events = events;

    this.issues = [];
    this.issuesByKey = {};
    this.issuesById = {};

    this.updates = new Updates();
    this.links = new Links();

    this.linkedCache = {};
    this.boardCache = null;

    this.updateContext = null;
    this.queuedUpdates = [];


    this.on('updateIssue', async event => {

      const {
        updatedIssue,
        update
      } = event;

      // ensure we always update the column
      // whenever an issue is being touched
      if (!update.column) {
        updatedIssue.column = this.columns.getIssueColumn(updatedIssue).name;
      }

      // attach a flag to column labels
      if (update.labels) {
        updatedIssue.labels = updatedIssue.labels.map(label => {

          if (this.columns.isColumnLabel(label.name)) {
            return {
              ...label,
              column_label: true
            };
          }

          return label;
        });
      }
    });

    this.on('issuesUpdated', async event => {

      const {
        context
      } = event;

      for (const update of context.getUpdates()) {

        const issue = context.getIssueById(update.id);

        const links = this.createLinks(context, issue);

        context.setLinks(issue, links);
      }
    }, 1500);

    this.on('issuesUpdated', async event => {

      const {
        context
      } = event;

      let firstIssue = this.issues[0];

      for (const update of context.getUpdates()) {

        const {
          id,
          order
        } = update;

        if (order) {
          continue;
        }

        const issue = context.getIssueById(id);

        const newLinks = context.getLinks(issue);

        const inverseLinks = this.links.getInverse(id);

        const links = {
          ...newLinks,
          ...inverseLinks
        };

        issue.order = this.getSemanticIssueOrder(issue, links, firstIssue);

        if (!firstIssue || firstIssue.order > issue.order) {
          firstIssue = issue;
        }
      }
    }, 1250);

    this.on('issuesUpdated', async event => {

      const {
        context
      } = event;

      // flush issues and links to persistent storage

      for (const update of context.getUpdates()) {

        const issue = context.getIssueById(update.id);

        this._flushIssue(context, issue);
      }
    }, 750);

    this.on('issuesUpdated', async event => {

      const {
        context
      } = event;

      // flush issues and links to persistent storage

      for (const update of context.getUpdates()) {

        const issue = this.getIssueById(update.id);

        const newLinks = context.getLinks(issue);

        this._flushLinks(context, issue, newLinks);
      }
    }, 500);

    this.on('issuesUpdated', async event => {

      const {
        context
      } = event;

      // publish updates for changed issues

      for (const issue of context.getTouchedIssues()) {

        this.updates.add(issue.id, {
          type: 'update',
          issue: {
            ...issue,
            links: this.getIssueLinks(issue)
          }
        });

      }

      // ensure board is re-computed on next request

      this.boardCache = null;
    }, 250);

  }

  queueUpdate(update) {

    const {
      id
    } = update;

    if (!id) {
      throw new Error('<id> required');
    }

    const t = Date.now();

    this.queuedUpdates.push({
      update,
      t: Date.now()
    });

    this.log.debug({ id: id }, 'update queued');

    return this.triggerUpdates().then(() => {

      this.log.debug({
        id: id,
        t: Date.now() - t
      }, 'update processed');

      return this.getIssueById(id);
    });
  }

  triggerUpdates() {

    if (!this.updateContext) {
      const context = this.updateContext = new UpdateContext(this);

      let error;

      this.processUpdates(context).catch(_error => {
        error = _error;
      }).finally(() => {
        this.updateContext = null;

        if (error) {
          context.reject(error);
        } else {
          context.resolve();
        }
      });

    }

    return this.updateContext.promise;
  }

  async processUpdates(context) {
    const t = Date.now();

    const processed = [];

    while (this.queuedUpdates.length) {
      const {
        t,
        deferred,
        update
      } = this.queuedUpdates.shift();

      await this.processUpdate(context, update);

      processed.push({
        t,
        deferred,
        update
      });
    }

    await this.emit('issuesUpdated', {
      context
    });

    this.log.info({
      t: Date.now() - t
    }, 'updates processed');
  }

  /**
   * Update a set of issues in a batch.
   *
   * @param {Function} iteratorFn
   *
   * @return {Promise<Array<Object>>} updated issues
   */
  updateIssues(iteratorFn) {

    const pendingUpdates = this.issues.map(issue => {
      const update = iteratorFn(issue);

      if (update) {
        return {
          id: issue.id,
          ...update
        };
      }
    }).filter(update => update);

    const updatePromises = pendingUpdates.map((update) => {
      return this.queueUpdate(update);
    });

    return Promise.all(updatePromises);
  }

  /**
   * Update issue, tagging it as updated.
   *
   * @return {Promise<Object>} promise to updated issue
   */
  updateIssue(update) {

    const {
      updated_at
    } = update;

    return this.queueUpdate({
      ...update,
      updated_at: updated_at || new Date().toISOString()
    });
  }

  async processUpdate(context, update) {

    const {
      id,
      updated_at
    } = update;

    if (!id) {
      const err = new Error('<id> required');

      this.log.error({
        err,
        update
      }, 'failed to process update');

      throw err;
    }

    if (updated_at) {
      this.log.debug({ issue: id }, 'bumping updated_at', new Date(updated_at));
    }

    const existingIssue = context.getIssueById(id) || {};

    const updatedIssue = {
      ...existingIssue,
      ...update
    };

    if (!updatedIssue.key) {
      const err = new Error('<key> required');

      this.log.error({
        err,
        existingIssue,
        issue: id,
        update
      }, 'failed to process update');

      throw err;
    }

    if (!updatedIssue.repository) {
      const err = new Error('<repository> required');

      this.log.error({
        err,
        existingIssue,
        issue: id,
        update
      }, 'failed to process update');

      throw err;
    }

    const ident = issueIdent(updatedIssue);

    this.log.debug({
      issue: ident
    }, 'process update');

    context.addUpdate(update);
    context.addTouchedIssue(updatedIssue);

    await this.emit('updateIssue', {
      context,
      existingIssue,
      update,
      updatedIssue
    });

    return updatedIssue;
  }

  getSemanticIssueOrder(issue, links, firstIssue) {

    const {
      id,
      column
    } = issue;

    const beforeTypes = {
      REQUIRED_BY: 1,
      CLOSES: 1,
      CHILD_OF: 1
    };

    const afterTypes = {
      DEPENDS_ON: 1,
      CLOSED_BY: 1,
      PARENT_OF: 1
    };

    let before, after;

    if (this.columns.isSorting(column)) {
      for (const link of Object.values(links)) {

        const {
          type,
          targetId
        } = link;

        const target = this.getIssueById(targetId);

        if (target && target.column === column) {

          if (beforeTypes[type]) {
            before = before && before.order < target.order ? before : target;
          }

          if (afterTypes[type]) {
            after = after && after.order > target.order ? after : target;
          }
        }
      }
    }

    const currentOrder = this.getIssueOrder(id);
    const currentColumn = this.getIssueColumn(id);

    if (!before && !after) {

      // keep order if issue stays within column
      if (column === currentColumn && typeof currentOrder === 'number') {
        return currentOrder;
      }

      // insert before other issues
      before = firstIssue;
    }

    return this._computeOrder(before && before.order, after && after.order, currentOrder);
  }

  createLinks(context, issue) {

    const { id, number: issueNumber } = issue;

    const repoAndOwner = {
      repo: issue.repository.name,
      owner: issue.repository.owner.login
    };

    return findLinks(issue).reduce((map, link) => {

      // add repository meta-data, if missing
      link = {
        ...repoAndOwner,
        ...link
      };

      const {
        owner,
        repo,
        number,
        type: linkType,
        ...linkAttrs
      } = link;

      // skip self links
      if (
        owner === repoAndOwner.owner &&
        repo === repoAndOwner.repo &&
        number === issueNumber
      ) {
        return map;
      }

      const linkedKey = `${owner}/${repo}#${number}`;

      const linkedIssue = context.getIssueByKey(linkedKey);

      if (linkedIssue) {

        const { id: targetId } = linkedIssue;

        const link = this.links.createLink(id, targetId, linkType, linkAttrs);

        map[link.key] = link;
      }

      return map;
    }, {});
  }

  _flushLinks(context, issue, newLinks) {

    const {
      id,
      key
    } = issue;

    const removedLinks = this.links.removeBySource(id);

    const inverseLinks = this.links.getInverse(id);

    for (const link of Object.values(newLinks)) {
      this.links.addLink(link);
    }

    delete this.linkedCache[id];

    const allLinks = {
      ...removedLinks,
      ...inverseLinks,
      ...newLinks
    };

    Object.values(allLinks).forEach(link => {

      const id = link.targetId;

      delete this.linkedCache[id];

      const issue = this.getIssueById(id);

      if (issue) {
        context.addTouchedIssue(issue);
      }
    });

    this.log.debug({
      issue: key
    }, 'links flushed');
  }

  _flushIssue(context, issue) {

    const {
      id,
      key,
      order,
      column
    } = issue;

    const existingIssue = this.issuesById[id];

    if (existingIssue) {
      delete this.issuesByKey[existingIssue.key];
    }

    this.issuesById[id] = issue;
    this.issuesByKey[key] = issue;

    const issues = this.issues;

    // ensure we do not double add issues
    const currentIdx = issues.findIndex(issue => issue.id === id);

    if (currentIdx !== -1) {

      // remove existing issue
      issues.splice(currentIdx, 1);
    }

    const insertIdx = issues.findIndex(issue => issue.order > order);

    if (insertIdx !== -1) {
      issues.splice(insertIdx, 0, issue);
    } else {
      issues.push(issue);
    }

    this.log.info({
      issue: key,
      order,
      column
    }, 'issue updated');
  }

  getIssueLinks(issue) {
    const { id } = issue;

    let linked = this.linkedCache[id];

    if (!linked) {
      linked = this.linkedCache[id] = Object.values(this.links.getBySource(id)).map(link => {

        const {
          targetId
        } = link;

        return {
          ...link,
          target: this.getIssueById(targetId)
        };
      }).filter(link => link.target);
    }

    return linked;
  }

  async removeIssueById(id) {

    const issue = this.getIssueById(id);

    if (!issue) {
      return;
    }

    this.log.info({ issue: issueIdent(issue) }, 'remove');

    const {
      key,
      repository
    } = issue;

    delete this.issuesById[id];
    delete this.issuesByKey[key];
    delete this.linkedCache[id];

    this.boardCache = null;

    this.issues = this.issues.filter(issue => issue.id !== id);

    const removedLinks = this.links.removeBySource(id);

    Object.values(removedLinks).forEach(link => {
      delete this.linkedCache[link.targetId];
    });

    this.updates.add(id, {
      type: 'remove',

      // dummy placeholder for removed issues
      issue: {
        id,
        key,
        repository,
        links: []
      }
    });
  }

  getIssues() {
    return this.issues;
  }

  updateIssueOrder(issue, before, after, column) {

    const {
      id
    } = issue;

    const order = this._computeOrder(
      before && this.getIssueOrder(before),
      after && this.getIssueOrder(after),
      this.getIssueOrder(id)
    );

    return this.updateIssue({
      id,
      column,
      order
    });
  }

  _computeOrder(beforeOrder, afterOrder, currentOrder) {

    if (beforeOrder && afterOrder) {
      return (
        typeof currentOrder === 'number' && currentOrder < beforeOrder && currentOrder > afterOrder
          ? currentOrder
          : (beforeOrder + afterOrder) / 2
      );
    }

    if (beforeOrder) {
      return (
        typeof currentOrder === 'number' && currentOrder < beforeOrder
          ? currentOrder
          : beforeOrder - 78567.92142
      );
    }

    if (afterOrder) {
      return (
        typeof currentOrder === 'number' && currentOrder > afterOrder
          ? currentOrder
          : afterOrder + 78567.12345
      );
    }

    // a good start :)
    return 709876.54321;
  }

  getIssueColumn(issueId) {
    const issue = this.getIssueById(issueId);

    return issue && issue.column;
  }

  getIssueOrder(issueId) {
    const issue = this.getIssueById(issueId);

    return issue && issue.order;
  }

  getIssueById(id) {
    return this.issuesById[id];
  }

  getIssueByKey(key) {
    return this.issuesByKey[key];
  }

  getBoard() {

    const boardCache = this.boardCache = (
      this.boardCache || groupBy(this.issues.map(issue => {
        return {
          ...issue,
          links: this.getIssueLinks(issue)
        };
      }), i => i.column)
    );

    return boardCache;
  }

  getUpdateCursor() {
    return this.updates.getHead().id;
  }

  getUpdates(cursor) {
    return this.updates.getSince(cursor);
  }

  /**
   * Register a store event listener
   *
   * The callback will be invoked with `event, ...additionalArguments`
   * that have been passed to {@link Events#emit}.
   *
   * Returning false from a listener will prevent the events default action
   * (if any is specified). To stop an event from being processed further in
   * other listeners execute {@link Event#stopPropagation}.
   *
   * Returning anything but `undefined` from a listener will stop the listener propagation.
   *
   * @param {string} event
   * @param {Function} callback
   * @param {number} [priority=1000] the priority in which this listener is called, larger is higher
   */
  on(event, callback, priority) {
    return this.events.on(`store.${event}`, callback, priority);
  }

  /**
   * Register a store event listener that is executed only once.
   *
   * @param {string} event the event name to register for
   * @param {Function} callback the callback to execute
   * @param {number} [priority=1000] the priority in which this listener is called, larger is higher
   */
  once(event, callback, priority) {
    return this.events.once(`store.${event}`, callback, priority);
  }

  /**
   * Emits a store event
   *
   * @param {string} [event] the optional event name
   * @param {Object} [data] the event object
   *
   * @return {Promise<boolean>} the events return value, if specified or false if the
   *                            default action was prevented by listeners
   */
  emit(event, data) {
    return this.events.emit(`store.${event}`, data);
  }

  /**
   * Serialize data to JSON so that it can
   * later be loaded via #loadJSON.
   */
  async asJSON() {

    const {
      issues,
      lastSync,
      links
    } = this;

    const data = {
      issues,
      lastSync,
      links: await links.asJSON()
    };

    await this.emit('serialize', { data });

    return JSON.stringify(data);
  }

  /**
   * Load a JSON object, previously serialized via Store#toJSON.
   */
  async loadJSON(json) {

    const data = JSON.parse(json);

    const {
      issues,
      lastSync,
      links
    } = data;

    this.issues = issues || [];
    this.lastSync = lastSync;

    if (links) {
      await this.links.loadJSON(links);
    }

    this.issuesById = this.issues.reduce((map, issue) => {
      map[issue.id] = issue;

      return map;
    }, {});

    this.issuesByKey = this.issues.reduce((map, issue) => {
      map[issue.key] = issue;

      return map;
    }, {});

    await this.emit('restored', { data });

    this.log.debug({
      issues: issues.length,
      lastSync
    }, 'load JSON complete');
  }

}


class UpdateContext {

  constructor(store) {
    const {
      resolve,
      reject,
      promise
    } = pDefer();

    this.store = store;

    this.updates = [];
    this.links = {};

    this.issuesById = {};
    this.issuesByKey = {};

    this.resolve = resolve;
    this.reject = reject;
    this.promise = promise;
  }

  addTouchedIssue(issue) {
    const {
      id,
      key
    } = issue;

    this.issuesById[id] = issue;
    this.issuesByKey[key] = issue;
  }

  addUpdate(update) {
    this.updates.push(update);
  }

  getTouchedIssues() {
    return Object.values(this.issuesById);
  }

  getIssueById(id) {
    return this.issuesById[id] || this.store.getIssueById(id);
  }

  getIssueByKey(key) {
    return this.issuesByKey[key] || this.store.getIssueByKey(key);
  }

  getUpdates() {
    return this.updates;
  }

  setLinks(issue, links) {
    this.links[issue.id] = links;
  }

  getLinks(issue) {
    return this.links[issue.id] || {};
  }

}


class Updates {

  constructor() {

    this.counter = 7841316;
    this.head = null;
    this.updateMap = {};
    this.trackedMap = {};
    this.list = [];

    // dummy update
    this.add({});
  }

  nextID() {
    return String(this.counter++);
  }

  getHead() {
    return this.head;
  }

  add(trackBy, update) {

    if (typeof update === 'undefined') {
      update = trackBy;
      trackBy = null;
    }

    const head = this.getHead();
    const id = this.nextID();

    const next = {
      id,
      next: null,
      ...update
    };

    if (trackBy) {
      const existing = this.trackedMap[trackBy];

      if (existing) {
        existing.tombstone = true;
      }

      this.trackedMap[trackBy] = next;
    }

    if (head) {
      head.next = next;
    }

    this.list.push(next);

    this.updateMap[id] = next;

    this.head = next;
  }

  getSince(id) {

    let update = (this.updateMap[id] || this.list[0]).next;

    const updates = [];

    while (update) {

      const {
        next,
        tombstone,
        ...actualUpdate
      } = update;

      if (!tombstone) {
        updates.push(actualUpdate);
      }

      update = update.next;
    }

    return updates;
  }

}

module.exports = Store;
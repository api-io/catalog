const bodyParser = require('body-parser').text();

const {
  withSession
} = require('../../middleware');

const {
  repoAndOwner
} = require('../../util');


const {
  filterIssueOrPull: _filterIssueOrPull
} = require('./board-api-filters');


/**
 * This component provides the board API routes.
 *
 * @param {Object} config
 * @param {import('../../store')} store
 * @param {import('../../types').Router} router
 * @param {import('../../types').Logger} logger
 * @param {import('../github-client/GithubClient')} githubClient
 * @param {import('../auth-routes/AuthRoutes')} authRoutes
 * @param {import('../user-access/UserAccess')} userAccess
 * @param {import('../github-issues/GithubIssues')} githubIssues
 * @param {import('../search/Search')} search
 * @param {import('../../columns')} columns
 */
module.exports = async (
    config, store,
    router, logger,
    githubClient, authRoutes,
    userAccess, githubIssues,
    search, columns
) => {

  const log = logger.child({
    name: 'wuffle:board-api-routes'
  });

  const middlewares = [
    withSession
  ];

  // endpoints ///////////////////

  function filterIssueOrPull(issueOrPull) {

    try {
      return _filterIssueOrPull(issueOrPull);
    } catch (err) {

      log.error({
        err,
        issueOrPull
      }, 'failed to filter issueOrPull');

      throw err;
    }
  }

  function getIssueSearchFilter(req) {
    const s = req.query.s || null;

    const user = authRoutes.getGitHubUser(req);

    return search.getSearchFilter(s, user);
  }

  function getIssueReadFilter(req) {
    const user = authRoutes.getGitHubUser(req);

    return userAccess.getReadFilter(user);
  }

  function filterBoardItems(req, items) {

    const searchFilter = getIssueSearchFilter(req);

    return getIssueReadFilter(req).then(canAccess => {

      return Object.entries(items).reduce((filteredItems, [ columnKey, columnIssues ]) => {

        const accessFiltered = columnIssues.filter(canAccess).map(issue => {

          const {
            links
          } = issue;

          return {
            ...issue,
            links: links.filter(l => canAccess(l.target))
          };
        });

        const searchFiltered = accessFiltered.filter(searchFilter);

        filteredItems[columnKey] = searchFiltered.map(filterIssueOrPull);

        return filteredItems;
      }, {});

    });

  }

  function filterUpdates(req, updates) {

    const searchFilter = getIssueSearchFilter(req);

    return getIssueReadFilter(req).then(canAccess => {

      const accessFiltered = updates.filter(update => canAccess(update.issue)).map(update => {
        const {
          issue
        } = update;

        const {
          links
        } = issue;

        return {
          ...update,
          issue: {
            ...issue,
            links: links.filter(l => canAccess(l.target))
          }
        };
      });

      const searchFiltered = accessFiltered.map(update => {

        if (searchFilter(update.issue)) {
          return update;
        }

        // remove from current view, as updated issue does not apply
        // to search filter anymore
        return {
          ...update,
          type: 'remove'
        };
      });

      return searchFiltered.map(update => {

        const { issue } = update;

        return {
          ...update,
          issue: filterIssueOrPull(issue)
        };
      });
    });

  }

  async function moveIssue(context, issue, columnDefinition, position) {

    // we move the issue via GitHub and rely on the automatic-dev-flow
    // to pick up the update (and react to it)

    const {
      before,
      after
    } = position;

    const column = columnDefinition.name;

    return Promise.all([
      store.updateIssueOrder(issue, before, after, column),
      githubIssues.moveIssue(context, issue, columnDefinition)
    ]);
  }

  // public endpoints ////////

  router.get('/wuffle/board/cards', ...middlewares, (req, res) => {

    const items = store.getBoard();
    const cursor = store.getUpdateCursor();

    return filterBoardItems(req, items).then(filteredItems => {

      res.type('json').json({
        items: filteredItems,
        cursor
      });
    }).catch(err => {
      log.error({
        err,
        cursor
      }, 'failed to retrieve cards');

      res.status(500).json({ error : true });
    });
  });


  router.get('/wuffle/board', ...middlewares, (req, res) => {

    const {
      columns,
      name
    } = config;

    return res.type('json').json({
      columns: columns.map(c => {
        const { name, collapsed } = c;

        return {
          name,
          collapsed: collapsed || false
        };
      }),
      name: name || 'Wuffle Board'
    });

  });


  router.get('/wuffle/board/updates', ...middlewares, (req, res) => {
    const cursor = req.query.cursor;

    const updates = cursor ? store.getUpdates(cursor) : [];

    return (
      filterUpdates(req, updates).then(filteredUpdates => {
        res.type('json').json(filteredUpdates);
      }).catch(err => {
        log.error({
          err,
          cursor
        }, 'failed to retrieve card updates');

        res.status(500).json({ error : true });
      })
    );
  });


  router.post('/wuffle/board/issues/move', ...middlewares, bodyParser, async (req, res) => {

    const user = authRoutes.getGitHubUser(req);

    if (!user) {
      return res.status(401).json({});
    }

    const body = JSON.parse(req.body);

    const {
      id,
      column: columnName,
      before,
      after
    } = body;

    const issue = await store.getIssueById(id);

    if (!issue) {
      return res.status(404).json({});
    }

    const column = columns.getByName(columnName);

    if (!column) {
      return res.status(404).json({});
    }

    const repo = repoAndOwner(issue);

    const canWrite = await userAccess.canWrite(user, repo);

    if (!canWrite) {
      return res.status(403).json({});
    }

    const octokit = await githubClient.getUserScoped(user);

    const context = {
      octokit,
      repo(opts) {
        return {
          ...repo,
          ...opts
        };
      }
    };

    return (
      moveIssue(context, issue, column, { before, after }).then(() => {
        res.type('json').json({});
      }).catch(err => {
        log.error(err, 'failed to move issue');

        res.status(500).json({ error : true });
      })
    );

  });

};
const JiraApi = require('jira-client');
const config = require('config')
const {createComment, mapFieldsToDescription, createResolveComment} = require("./jiraMessages");
const {wikiToAdf, adfToText} = require("./adf");

let systemAccountId
let systemAccountIdPromise

const issueTypeId = config.get('jira.issue_type_id')
const issueTypeName = config.get('jira.issue_type_name')

const jiraProject = config.get('jira.project')

const jiraStartTransitionId = config.get('jira.start_transition_id')
const jiraDoneTransitionId = config.get('jira.done_transition_id')
const extractProjectRegex = new RegExp(`(${jiraProject}-[\\d]+)`)

const jiraBaseUrl = new URL(config.get('jira.base_url'))

const jira = new JiraApi({
    protocol: 'https',
    host: jiraBaseUrl.hostname,
    port: jiraBaseUrl.port,
    base: jiraBaseUrl.pathname.replace(/\/+$/, ''),
    username: config.get('jira.username'),
    password: config.get('jira.api_token'),
    apiVersion: '3',
    strictSSL: true
});

async function getSystemAccountId() {
    if (systemAccountId) {
        return systemAccountId
    }

    if (!systemAccountIdPromise) {
        systemAccountIdPromise = jira.getCurrentUser()
            .then(user => {
                systemAccountId = user?.accountId
                return systemAccountId
            })
            .catch(err => {
                console.log("Unable to resolve Jira service account ID", err)
                return undefined
            })
    }

    return systemAccountIdPromise
}

async function resolveHelpRequest(jiraId) {
    try {
        await jira.transitionIssue(jiraId, {
            transition: {
                id: jiraDoneTransitionId
            }
        })
    } catch (err) {
        console.log("Error resolving help request in jira", err)
    }
}

async function markAsDuplicate(jiraIdToUpdate, parentJiraId) {
    try {
        await jira.issueLink({
            type: {
                name: "Duplicate"
            },
            inwardIssue: {
                key: jiraIdToUpdate
            },
            outwardIssue: {
                key: parentJiraId
            },
        });

        await jira.transitionIssue(jiraIdToUpdate, {
            transition: {
                id: jiraDoneTransitionId
            }
        })
    } catch (err) {
        console.log("Error marking help request as duplicate in jira", err)
    }
}


async function startHelpRequest(jiraId) {
    try {
        await jira.transitionIssue(jiraId, {
            transition: {
                id: jiraStartTransitionId
            }
        })
    } catch (err) {
        console.log("Error starting help request in jira", err)
    }
}

function isIssueNotFound(err) {
    const message = (err && (err.message || err)) + ''
    return /does not exist|not find|not found/i.test(message)
}

async function getIssueDescription(issueId) {
    try {
        const uri = jira.makeUri({
            pathname: `/issue/${issueId}`,
            query: { fields: 'description' }
        });
        const issue = await jira.doRequest(jira.makeRequestHeader(uri));
        const description = issue && issue.fields && issue.fields.description;
        return description ? adfToText(description) : undefined;
    } catch (err) {
        if (isIssueNotFound(err)) {
            return undefined;
        } else {
            throw err
        }

    }
}

async function searchForUnassignedOpenIssues() {
    const jqlQuery = `project = ${jiraProject} AND type = "${issueTypeName}" AND status = Open and assignee is EMPTY AND labels not in ("Heritage") ORDER BY created ASC`;
    try {
        const uri = jira.makeUri({ pathname: '/search/jql' });
        const results = await jira.doRequest(jira.makeRequestHeader(uri, {
            method: 'POST',
            body: {
                jql: jqlQuery,
                fields: ['created', 'description', 'summary', 'updated']
            }
        }))

        const issues = (results.issues || []).map((issue) => ({
            ...issue,
            fields: {
                ...issue.fields,
                description: adfToText(issue.fields && issue.fields.description)
            }
        }))

        return {
            issues
        }
    } catch (err) {
        console.log("Error searching for issues in jira", err)
        return {
            issues: []
        }
    }
}

async function assignHelpRequest(issueId, email) {
    const user = await convertEmail(email)

    try {
        await jira.updateAssigneeWithId(issueId, user)
    } catch(err) {
        console.log("Error assigning help request in jira", err)
    }
}

/**
 * Extracts a jira ID
 *
 * expected format: 'View on Jira: <https://hmcts.atlassian.net/browse/SBOX-61|SBOX-61>'
 * @param blocks
 */
function extractJiraIdFromBlocks(blocks) {
    let viewOnJiraText
    if (blocks.length === 3) {
        viewOnJiraText = blocks[2].fields[0].text
    } else {
        viewOnJiraText = blocks[4].elements[0].text
    }

    project = extractProjectRegex.exec(viewOnJiraText);

    return (project) ? project[1] : 'undefined';
}

function extraJiraId(text) {
    return extractProjectRegex.exec(text)[1]
}

async function convertEmail(email) {
    if (!email) {
        return getSystemAccountId()
    }

    try {
        const res = await jira.searchUsers({
            query: email,
            maxResults: 1
        })

        if (!res.length) {
            return undefined
        }

        return res[0].accountId || res[0].name
    } catch(ex) {
        console.log("Querying username failed: " + ex)
        return getSystemAccountId()
    }
}

async function createHelpRequestInJira(summary, project, user, labels) {
    console.log(`Creating help request in Jira for user: ${user}`)
    const issue = await jira.addNewIssue({
        fields: {
            summary: summary,
            issuetype: {
                id: issueTypeId
            },
            project: {
                id: project.id
            },
            labels: ['created-from-slack', ...labels],
            description: undefined,
            ...(user ? { reporter: { accountId: user } } : {})
        }
    });

    return issue;
}

async function createHelpRequest({
                                     summary,
                                     userEmail,
                                     labels
                                 }) {
    const user = await convertEmail(userEmail)

    const project = await jira.getProject(jiraProject);
    console.log(`Preparing to create in project ${jiraProject}/${project.id}, issue id ${issueTypeId}, issue name ${issueTypeName}`);

    // https://developer.atlassian.com/cloud/jira/platform/rest/v2/api-group-issues/#api-rest-api-2-issue-post
    // note: fields don't match 100%, our Jira version is a bit old (still a supported LTS though)

    let result
    try {
        result = await createHelpRequestInJira(summary, project, user, labels);
        console.log(JSON.stringify(result));
    } catch(err) {
        // In case the user doesn't exist in Jira, use the authenticated service account.
        const fallbackAccountId = await getSystemAccountId()
        result = await createHelpRequestInJira(summary, project, fallbackAccountId, labels);
        console.log(JSON.stringify(result));
        
        if (!result.key) {
            console.log("Error creating help request in jira", JSON.stringify(result));
        }
    }

    return result.key
}

async function updateHelpRequestDescription(issueId, fields) {
    const jiraDescription = wikiToAdf(mapFieldsToDescription(fields));
    try {
        await jira.updateIssue(issueId, {
            update: {
                description: [{
                    set: jiraDescription
                }]
            }
        })
    } catch(err) {
        console.log("Error updating help request description in jira", err)
    }
}

async function addCommentToHelpRequest(externalSystemId, fields) {
    try {
        await jira.addComment(externalSystemId, wikiToAdf(createComment(fields)))
    } catch (err) {
        console.log("Error creating comment in jira", err)
    }
}

async function addCommentToHelpRequestResolve(externalSystemId, { what, where, how} ) {
    try {
        await jira.addComment(externalSystemId, wikiToAdf(createResolveComment({what, where, how})))
    } catch (err) {
        console.log("Error creating comment in jira", err)
    }
}

async function addLabel(externalSystemId, { category} ) {
    try {
        await jira.updateIssue(externalSystemId, {
            update: {
                labels: [{
                    add: `resolution-${category.toLowerCase().replaceAll(' ', '-')}`
                }]
            }
        })
    } catch(err) {
        console.log("Error updating help request description in jira", err)
    }
}


module.exports.resolveHelpRequest = resolveHelpRequest
module.exports.startHelpRequest = startHelpRequest
module.exports.assignHelpRequest = assignHelpRequest
module.exports.createHelpRequest = createHelpRequest
module.exports.updateHelpRequestDescription = updateHelpRequestDescription
module.exports.addCommentToHelpRequest = addCommentToHelpRequest
module.exports.addCommentToHelpRequestResolve = addCommentToHelpRequestResolve
module.exports.addLabel = addLabel
module.exports.convertEmail = convertEmail
module.exports.extraJiraId = extraJiraId
module.exports.extractJiraIdFromBlocks = extractJiraIdFromBlocks
module.exports.searchForUnassignedOpenIssues = searchForUnassignedOpenIssues
module.exports.getIssueDescription = getIssueDescription
module.exports.markAsDuplicate = markAsDuplicate

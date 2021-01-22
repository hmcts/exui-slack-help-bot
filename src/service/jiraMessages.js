function optionalField(prefix, value) {
    if (value) {
        return `*${prefix}*: ${value}`
    }
    return ""
}

function mapFieldsToDescription(
    {
        prBuildUrl,
        environment,
        description,
        analysis,
        checkedWithTeam,
        actionRequired,
        slackLink
    }) {
    return `
h6. _This is an automatically generated ticket created from Slack, do not reply or update in here, [view in Slack|${slackLink}]_

${optionalField('PR / build URLs', prBuildUrl)}


${optionalField('Environment', environment)}

*Issue description*

${description}

*Analysis done so far*: ${analysis}

*Have you checked with your team?*: ${checkedWithTeam}

${optionalField('Action required', actionRequired)}
`
}

module.exports.mapFieldsToDescription = mapFieldsToDescription
'use strict'

const crypto = require('crypto')
const fs = require('fs')

async function postJson(url, token, payload, operation) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}: ${body.slice(0, 300)}`)
  }
  return JSON.parse(body)
}

async function main() {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN || ''
  const resultsUrl = process.env.ACTIONS_RESULTS_URL || ''
  const artifactName = process.env.INPUT_ARTIFACT_NAME || ''
  const zipPath = process.env.INPUT_ZIP_PATH || ''
  if (!runtimeToken || !resultsUrl || !artifactName || !zipPath) {
    throw new Error('required Actions Results capability or input is unavailable')
  }

  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url'))
  const scope = claims.scp
    .split(' ')
    .find(item => item.startsWith('Actions.Results:'))
  if (!scope) {
    throw new Error('Actions Results scope is unavailable')
  }
  const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':')
  const service = `${new URL(resultsUrl).origin}/twirp/github.actions.results.api.v1.ArtifactService`
  const common = {
    workflow_run_backend_id: workflowRunBackendId,
    workflow_job_run_backend_id: workflowJobRunBackendId,
    name: artifactName
  }

  const create = await postJson(
    `${service}/CreateArtifact`,
    runtimeToken,
    {...common, version: 7, mime_type: 'application/zip'},
    'CreateArtifact'
  )
  if (!create.ok || !create.signed_upload_url) {
    throw new Error('CreateArtifact returned no upload capability')
  }

  const archive = fs.readFileSync(zipPath)
  const digest = crypto.createHash('sha256').update(archive).digest('hex')
  const upload = await fetch(create.signed_upload_url, {
    method: 'PUT',
    headers: {
      'content-type': 'application/zip',
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': '2021-12-02'
    },
    body: archive
  })
  if (!upload.ok) {
    throw new Error(`artifact blob upload failed with HTTP ${upload.status}`)
  }

  const finalize = await postJson(
    `${service}/FinalizeArtifact`,
    runtimeToken,
    {...common, size: String(archive.length), hash: `sha256:${digest}`},
    'FinalizeArtifact'
  )
  if (!finalize.ok || !finalize.artifact_id) {
    throw new Error('FinalizeArtifact returned no artifact ID')
  }

  console.log(
    `artifact_name=${artifactName} artifact_id=${finalize.artifact_id} size=${archive.length} digest=sha256:${digest}`
  )
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

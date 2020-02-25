#!/usr/bin/env node

import {
  appendFileSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
} from 'fs'
import {exec} from 'child_process'
import tmp from 'tmp'
import mime from 'mime-types'
import {v4 as uuid} from 'uuid'

const logFile = '/tmp/cdn-deploy.log'
const configFile = '/tmp/cdn/cdn.json'
let basePath = '/tmp/cdn'
let db
const seen = {}

const patternImport = new RegExp(
  /import(?:["'\s]*([\w*${}\n\r\t, ]+)from\s*)?["'\s]["'\s](.*[@\w_-]+)["'\s].*$/,
  'mg'
)
const patternDImport = new RegExp(
  /import\((?:["'\s]*([\w*{}\n\r\t, ]+)\s*)?["'\s](.*([@\w_-]+))["'\s].*\)$/,
  'mg'
)
const globalImport = new RegExp(/(cdn-import)\((.+)\)/, 'mg')

function loadDb() {
  const db = JSON.parse(readFileSync(configFile, 'utf8'))
  if (!db.files) {
    db.files = {}
  }
  if (db.base) {
    basePath =
      basePath + '/' + db.base.replace(/^[\./]+/, '').replace(/\/+$/, '')
  }
  return db
}

function saveDb() {
  writeFileSync(configFile, JSON.stringify(db, null, 2))
}

function maybeDeploy(file, callTree = []) {
  if (seen[file]) {
    return seen[file]
  }

  if (callTree.includes(file)) {
    throw new Error(
      'Circular dependency detected, which this script has no support for! ' +
        JSON.stringify(callTree) +
        ' detected in adding ' +
        file
    )
  }

  return (seen[file] = deploy(file, [...callTree, file]))
}

async function deploy(me, callTree) {
  db.files[me] = db.files[me] || {
    version: 0,
    hash: '',
    dependencies: {},
  }
  const dependencies = await getDependencies(me)

  await Promise.all(
    dependencies.map(dependency => maybeDeploy(dependency.absolute, callTree))
  )
  const myHash = await getFileHash(me)

  const anyDependencyChanged = dependencies.find(
    d =>
      !db.files[me].dependencies[d.absolute] ||
      db.files[me].dependencies[d.absolute] !== db.files[d.absolute].version
  )
  const meChanged = myHash !== db.files[me].hash

  if (anyDependencyChanged || meChanged) {
    db.files[me].version++
    db.files[me].hash = myHash
    db.files[me].dependencies = {}
    dependencies.forEach(d => {
      db.files[me].dependencies[d.absolute] = db.files[d.absolute].version
    })

    const {path, filename} = await createInjectedTempfile(me)
    const destination =
      db.target +
      ('/' + me.slice(2, me.lastIndexOf('/')) + '/' + filename).replace(
        /\/\//g,
        '/'
      )
    let url = destination.slice(db.target.length)
    if (db.targetUrl) {
      url = destination.replace(/^[a-z]+:\/\/[^\/]+/, db.targetUrl)
    }

    await upload(path, destination, myHash, url)

    if (db.targetUrl) {
      db.files[me].url = url
    }
    saveDb()
  }
}

async function createInjectedTempfile(file) {
  let contents = await readFileSync(`${basePath}/${file}`, 'utf8')

  ;(await getDependencies(file)).forEach(({raw, absolute}) => {
    const version = db.files[file].dependencies[absolute]
    let index = raw.lastIndexOf('.')
    if (index < 0) {
      index = raw.length - 1
    }
    contents = contents
      .split(raw)
      .join(raw.slice(0, index) + '-' + version + raw.slice(index))
  })

  const filename = file.slice(file.lastIndexOf('/') + 1)
  const newFilename =
    filename.slice(0, filename.lastIndexOf('.')) +
    '-' +
    db.files[file].version +
    filename.slice(filename.lastIndexOf('.'))

  const tmpObj = tmp.fileSync({postfix: '--' + newFilename})
  writeFileSync(tmpObj.fd, contents)
  return {
    path: tmpObj.name,
    filename: newFilename,
  }
}

async function upload(source, realDestination, hash, url) {
  // first we upload to a staging area with multiple operations, then copy over to the correct destination
  const destination = db.target + '/_tmp/' + uuid()

  const mimetype = mime.lookup(source) || 'application/octet-stream'

  cmd(`cat "${source}" | gzip | gsutil cp - "${destination}"`),
    await retrycmd(`
    gsutil setmeta \
      -h "Cache-Control: public, max-age=31536000" \
      -h "Content-Encoding: gzip" \
      -h "Content-Type: ${mimetype}" \
      "${destination}" 
  `)
  await retrycmd(`gsutil acl ch -u AllUsers:R "${destination}"`),
    await retrycmd(`gsutil cp "${destination}" "${realDestination}"`)

  console.log(url)
}

async function getDependencies(file) {
  if (!getDependencies.cache) {
    getDependencies.cache = {}
  }

  if (getDependencies.cache[file]) {
    return getDependencies.cache[file]
  }

  const js = readFileSync(`${basePath}/${file}`, 'utf8')

  const imports = [
    ...js.matchAll(patternImport),
    ...js.matchAll(patternDImport),
    ...js.matchAll(globalImport),
  ]
    .filter(m => m[2].startsWith('.'))
    .map(m => ({
      raw: m[2],
      absolute: absPath(`${basePath}/${file}/../${m[2]}`),
    }))

  getDependencies.cache[file] = imports

  return imports
}

function getFileHash(file) {
  return cmd(`git rev-parse --short=1 $(git rev-list -1 master -- "${file}")`)
}

async function retrycmd(...args) {
  while (true) {
    try {
      return await cmd(...args)
    } catch (e) {
      console.error(
        `++++ gsutil failed as usual, but no worries we retry the call in 100ms`
      )
      await new Promise(res => setTimeout(res, 100))
    }
  }
}

let workers = 0
const queue = []
async function cmd(str, nocwd = false) {
  await new Promise(res => {
    queue.push(res)
  })

  try {
    workers += 1

    const opts = {}

    if (!nocwd) {
      opts.cwd = basePath
    }

    return await new Promise((res, reject) => {
      let printstr = str.trim()
      while (printstr.indexOf('  ') !== -1) {
        printstr = printstr.replace(/  /g, ' ')
      }
      log(printstr)

      exec(str, opts, (error, stdout, stderr) => {
        if (error) {
          reject(printstr + ': ' + stderr.trim())
        } else {
          res(stdout.trim())
        }
      })
    })
  } finally {
    workers -= 1
  }
}
function checkQueue() {
  if (queue.length > 0 && workers < 40) {
    queue.shift()()
  }
}

function absPath(file) {
  const ret = '.' + realpathSync(file).substr(basePath.length)
  return ret
}

function log(str) {
  appendFileSync(logFile, str)
}

async function start() {
  log('======= NEW DEPLOY: ' + process.cwd())
  try {
    setInterval(checkQueue, 5)
    if (existsSync(basePath)) {
      await cmd(`git worktree remove /tmp/cdn`, true)
    }

    await cmd(`git fetch && git push`, true)
    await cmd(`git worktree add /tmp/cdn`, true)
    await cmd(`git reset --hard origin/master`)
    db = await loadDb()
    await maybeDeploy(absPath(`${basePath}/${db.entry}`))
    saveDb()
    await cmd(
      `git add ${configFile} ; git commit -m 'CDN' ; git push origin cdn:master`
    )
    await cmd(`git worktree remove /tmp/cdn`, true)
  } catch (e) {
    console.error(e)
  } finally {
    clearInterval(checkQueue)
    process.exit(0)
  }
}

start()

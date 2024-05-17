import { Base64 } from 'js-base64'
import URL from 'url-parse'
import DetailedError from './error'
import { log } from './logger'
import uuid from './uuid'

const PROTOCOL_TUS_V1 = 'tus-v1'
const PROTOCOL_IETF_DRAFT_03 = 'ietf-draft-03'

export const defaultOptions = {
  endpoint: null,

  uploadUrl: null,
  metadata: {},
  fingerprint: null,
  uploadSize: null,

  onProgress: null,
  onChunkComplete: null,
  onSuccess: null,
  onError: null,
  onUploadUrlAvailable: null,

  overridePatchMethod: false,
  headers: {},
  addRequestId: false,
  onBeforeRequest: null,
  onAfterResponse: null,
  onShouldRetry: defaultOnShouldRetry,

  chunkSize: Infinity,
  retryDelays: [0, 1000, 3000, 5000],
  parallelUploads: 1,
  parallelUploadBoundaries: null,
  storeFingerprintForResuming: true,
  removeFingerprintOnSuccess: false,
  uploadLengthDeferred: false,
  uploadDataDuringCreation: false,

  urlStorage: null,
  fileReader: null,
  httpStack: null,

  protocol: PROTOCOL_TUS_V1,
}

// TODO: Put this into its own file
export interface UploadOptions<F, S> {
  // TODO: Embrace undefined over null
  endpoint: string | null

  uploadUrl: string | null
  metadata: { [key: string]: string }
  fingerprint: (file: F, options: UploadOptions<F, S>) => Promise<string | null>
  uploadSize: number | null

  onProgress: ((bytesSent: number, bytesTotal: number) => void) | null
  onChunkComplete: ((chunkSize: number, bytesAccepted: number, bytesTotal: number) => void) | null
  onSuccess: (() => void) | null
  onError: ((error: Error | DetailedError) => void) | null
  onShouldRetry:
    | ((error: DetailedError, retryAttempt: number, options: UploadOptions<F, S>) => boolean)
    | null
  onUploadUrlAvailable: (() => void) | null

  overridePatchMethod: boolean
  headers: { [key: string]: string }
  addRequestId: boolean
  onBeforeRequest: ((req: HttpRequest<S>) => void | Promise<void>) | null
  onAfterResponse: ((req: HttpRequest<S>, res: HttpResponse) => void | Promise<void>) | null

  chunkSize: number
  retryDelays: number[]
  parallelUploads: number
  parallelUploadBoundaries: { start: number; end: number }[] | null
  storeFingerprintForResuming: boolean
  removeFingerprintOnSuccess: boolean
  uploadLengthDeferred: boolean
  uploadDataDuringCreation: boolean

  urlStorage: UrlStorage
  fileReader: FileReader<F, S>
  httpStack: HttpStack<S>

  protocol: string
}

export interface UrlStorage {
  findAllUploads(): Promise<PreviousUpload[]>
  findUploadsByFingerprint(fingerprint: string): Promise<PreviousUpload[]>

  removeUpload(urlStorageKey: string): Promise<void>

  // Returns the URL storage key, which can be used for removing the upload.
  addUpload(fingerprint: string, upload: PreviousUpload): Promise<string | void>
}

export interface PreviousUpload {
  size: number | null
  metadata: { [key: string]: string }
  creationTime: string
  uploadUrl?: string
  parallelUploadUrls?: string[]
}

export interface FileReader<F, S> {
  openFile(input: F, chunkSize: number): Promise<FileSource<S>>
}

export interface FileSource<S> {
  size: number | null
  slice(start: number, end: number): Promise<SliceResult<S>>
  close(): void
}

export interface SliceResult<S> {
  // Platform-specific data type which must be usable by the HTTP stack as a body.
  // TODO: This should be a separate property and be set every time. Otherwise we track the wrong size.
  value: S & { size?: number }
  done: boolean
}

export interface HttpStack<B> {
  createRequest(method: string, url: string): HttpRequest<B>
  getName(): string
}

export type HttpProgressHandler = (bytesSent: number) => void

export interface HttpRequest<B> {
  getMethod(): string
  getURL(): string

  setHeader(header: string, value: string): void
  getHeader(header: string): string | undefined

  setProgressHandler(handler: HttpProgressHandler): void
  send(body?: B): Promise<HttpResponse>
  abort(): Promise<void>

  // Return an environment specific object, e.g. the XMLHttpRequest object in browsers.
  getUnderlyingObject(): unknown
}

export interface HttpResponse {
  getStatus(): number
  getHeader(header: string): string | undefined
  getBody(): string

  // Return an environment specific object, e.g. the XMLHttpRequest object in browsers.
  getUnderlyingObject(): unknown
}

export default class BaseUpload<F, S> {
  options: UploadOptions<F, S>

  // The storage module used to store URLs
  _urlStorage: UrlStorage

  // The underlying File/Blob object
  file: F

  // The URL against which the file will be uploaded
  url: string | null = null

  // The underlying request object for the current PATCH request
  _req: HttpRequest<S> | null = null

  // The fingerpinrt for the current file (set after start())
  _fingerprint: string | null = null

  // The key that the URL storage returned when saving an URL with a fingerprint,
  _urlStorageKey: string | null = null

  // The offset used in the current PATCH request
  _offset = 0

  // True if the current PATCH request has been aborted
  _aborted = false

  // The file's size in bytes
  _size: number | null = null

  // The Source object which will wrap around the given file and provides us
  // with a unified interface for getting its size and slice chunks from its
  // content allowing us to easily handle Files, Blobs, Buffers and Streams.
  _source: FileSource<S> | null = null

  // The current count of attempts which have been made. Zero indicates none.
  _retryAttempt = 0

  // The timeout's ID which is used to delay the next retry
  _retryTimeout: unknown | null = null

  // The offset of the remote upload before the latest attempt was started.
  _offsetBeforeRetry = 0

  // An array of BaseUpload instances which are used for uploading the different
  // parts, if the parallelUploads option is used.
  _parallelUploads?: BaseUpload<F, S>[]

  // An array of upload URLs which are used for uploading the different
  // parts, if the parallelUploads option is used.
  _parallelUploadUrls?: string[]

  constructor(file: F, options: UploadOptions<F, S>) {
    // Warn about removed options from previous versions
    if ('resume' in options) {
      // eslint-disable-next-line no-console
      console.log(
        'tus: The `resume` option has been removed in tus-js-client v2. Please use the URL storage API instead.',
      )
    }

    // The default options will already be added from the wrapper classes.
    this.options = options

    // Cast chunkSize to integer
    // TODO: Remove this cast
    this.options.chunkSize = Number(this.options.chunkSize)

    this.file = file

    // TODO: Remove this property
    this._urlStorage = options.urlStorage
  }

  findPreviousUploads() {
    return this.options.fingerprint(this.file, this.options).then((fingerprint) => {
      if (!fingerprint) {
        return Promise.reject(new Error('unable calculate fingerprint for this input file'))
      }

      return this._urlStorage.findUploadsByFingerprint(fingerprint)
    })
  }

  resumeFromPreviousUpload(previousUpload) {
    this.url = previousUpload.uploadUrl || null
    this._parallelUploadUrls = previousUpload.parallelUploadUrls || null
    this._urlStorageKey = previousUpload.urlStorageKey
  }

  start() {
    const { file } = this

    if (!file) {
      this._emitError(new Error('tus: no file or stream to upload provided'))
      return
    }

    if (![PROTOCOL_TUS_V1, PROTOCOL_IETF_DRAFT_03].includes(this.options.protocol)) {
      this._emitError(new Error(`tus: unsupported protocol ${this.options.protocol}`))
      return
    }

    if (!this.options.endpoint && !this.options.uploadUrl && !this.url) {
      this._emitError(new Error('tus: neither an endpoint or an upload URL is provided'))
      return
    }

    const { retryDelays } = this.options
    if (retryDelays != null && Object.prototype.toString.call(retryDelays) !== '[object Array]') {
      this._emitError(new Error('tus: the `retryDelays` option must either be an array or null'))
      return
    }

    if (this.options.parallelUploads > 1) {
      // Test which options are incompatible with parallel uploads.
      for (const optionName of ['uploadUrl', 'uploadSize', 'uploadLengthDeferred']) {
        if (this.options[optionName]) {
          this._emitError(
            new Error(`tus: cannot use the ${optionName} option when parallelUploads is enabled`),
          )
          return
        }
      }
    }

    if (this.options.parallelUploadBoundaries) {
      if (this.options.parallelUploads <= 1) {
        this._emitError(
          new Error(
            'tus: cannot use the `parallelUploadBoundaries` option when `parallelUploads` is disabled',
          ),
        )
        return
      }
      if (this.options.parallelUploads !== this.options.parallelUploadBoundaries.length) {
        this._emitError(
          new Error(
            'tus: the `parallelUploadBoundaries` must have the same length as the value of `parallelUploads`',
          ),
        )
        return
      }
    }

    this.options
      .fingerprint(file, this.options)
      .then((fingerprint) => {
        if (fingerprint == null) {
          log(
            'No fingerprint was calculated meaning that the upload cannot be stored in the URL storage.',
          )
        } else {
          log(`Calculated fingerprint: ${fingerprint}`)
        }

        this._fingerprint = fingerprint

        if (this._source) {
          return this._source
        }
        return this.options.fileReader.openFile(file, this.options.chunkSize)
      })
      .then((source) => {
        this._source = source

        // First, we look at the uploadLengthDeferred option.
        // Next, we check if the caller has supplied a manual upload size.
        // Finally, we try to use the calculated size from the source object.
        if (this.options.uploadLengthDeferred) {
          this._size = null
        } else if (this.options.uploadSize != null) {
          this._size = Number(this.options.uploadSize)
          if (Number.isNaN(this._size)) {
            this._emitError(new Error('tus: cannot convert `uploadSize` option into a number'))
            return
          }
        } else {
          this._size = this._source.size
          if (this._size == null) {
            this._emitError(
              new Error(
                "tus: cannot automatically derive upload's size from input. Specify it manually using the `uploadSize` option or use the `uploadLengthDeferred` option",
              ),
            )
            return
          }
        }

        // If the upload was configured to use multiple requests or if we resume from
        // an upload which used multiple requests, we start a parallel upload.
        if (this.options.parallelUploads > 1 || this._parallelUploadUrls != null) {
          this._startParallelUpload()
        } else {
          this._startSingleUpload()
        }
      })
      .catch((err) => {
        this._emitError(err)
      })
  }

  /**
   * Initiate the uploading procedure for a parallelized upload, where one file is split into
   * multiple request which are run in parallel.
   *
   * @api private
   */
  _startParallelUpload() {
    const totalSize = this._size
    let totalProgress = 0
    this._parallelUploads = []

    const partCount =
      this._parallelUploadUrls != null
        ? this._parallelUploadUrls.length
        : this.options.parallelUploads

    // The input file will be split into multiple slices which are uploaded in separate
    // requests. Here we get the start and end position for the slices.
    const partsBoundaries =
      this.options.parallelUploadBoundaries ?? splitSizeIntoParts(this._size, partCount)

    // Attach URLs from previous uploads, if available.
    const parts = partsBoundaries.map((part, index) => ({
      ...part,
      uploadUrl: this._parallelUploadUrls?.[index] || null,
    }))

    // Create an empty list for storing the upload URLs
    this._parallelUploadUrls = new Array(parts.length)

    // Generate a promise for each slice that will be resolve if the respective
    // upload is completed.
    const uploads = parts.map((part, index) => {
      let lastPartProgress = 0

      // @ts-expect-error We know that `_source` is not null here.
      return this._source.slice(part.start, part.end).then(
        ({ value }) =>
          new Promise<void>((resolve, reject) => {
            // Merge with the user supplied options but overwrite some values.
            const options = {
              ...this.options,
              // If available, the partial upload should be resumed from a previous URL.
              uploadUrl: part.uploadUrl || null,
              // We take manually care of resuming for partial uploads, so they should
              // not be stored in the URL storage.
              storeFingerprintForResuming: false,
              removeFingerprintOnSuccess: false,
              // Reset the parallelUploads option to not cause recursion.
              parallelUploads: 1,
              // Reset this option as we are not doing a parallel upload.
              parallelUploadBoundaries: null,
              metadata: {},
              // Add the header to indicate the this is a partial upload.
              headers: {
                ...this.options.headers,
                'Upload-Concat': 'partial',
              },
              // Reject or resolve the promise if the upload errors or completes.
              onSuccess: resolve,
              onError: reject,
              // Based in the progress for this partial upload, calculate the progress
              // for the entire final upload.
              onProgress: (newPartProgress) => {
                totalProgress = totalProgress - lastPartProgress + newPartProgress
                lastPartProgress = newPartProgress
                this._emitProgress(totalProgress, totalSize)
              },
              // Wait until every partial upload has an upload URL, so we can add
              // them to the URL storage.
              onUploadUrlAvailable: () => {
                // @ts-expect-error We know that _parallelUploadUrls is defined
                this._parallelUploadUrls[index] = upload.url
                // Test if all uploads have received an URL
                // @ts-expect-error We know that _parallelUploadUrls is defined
                if (this._parallelUploadUrls.filter((u) => Boolean(u)).length === parts.length) {
                  this._saveUploadInUrlStorage()
                }
              },
            }

            // @ts-expect-error We still have to figure out the size for files
            const upload = new BaseUpload(value, options)
            upload.start()

            // Store the upload in an array, so we can later abort them if necessary.
            // @ts-expect-error We know that _parallelUploadUrls is defined
            this._parallelUploads.push(upload)
          }),
      )
    })

    let req
    // Wait until all partial uploads are finished and we can send the POST request for
    // creating the final upload.
    Promise.all(uploads)
      .then(() => {
        req = this._openRequest('POST', this.options.endpoint)
        // @ts-expect-error We know that _parallelUploadUrls is defined
        req.setHeader('Upload-Concat', `final;${this._parallelUploadUrls.join(' ')}`)

        // Add metadata if values have been added
        const metadata = encodeMetadata(this.options.metadata)
        if (metadata !== '') {
          req.setHeader('Upload-Metadata', metadata)
        }

        return this._sendRequest(req)
      })
      .then((res) => {
        if (!inStatusCategory(res.getStatus(), 200)) {
          this._emitHttpError(req, res, 'tus: unexpected response while creating upload')
          return
        }

        const location = res.getHeader('Location')
        if (location == null) {
          this._emitHttpError(req, res, 'tus: invalid or missing Location header')
          return
        }

        this.url = resolveUrl(this.options.endpoint, location)
        log(`Created upload at ${this.url}`)

        this._emitSuccess()
      })
      .catch((err) => {
        this._emitError(err)
      })
  }

  /**
   * Initiate the uploading procedure for a non-parallel upload. Here the entire file is
   * uploaded in a sequential matter.
   *
   * @api private
   */
  _startSingleUpload() {
    // Reset the aborted flag when the upload is started or else the
    // _performUpload will stop before sending a request if the upload has been
    // aborted previously.
    this._aborted = false

    // The upload had been started previously and we should reuse this URL.
    if (this.url != null) {
      log(`Resuming upload from previous URL: ${this.url}`)
      this._resumeUpload()
      return
    }

    // A URL has manually been specified, so we try to resume
    if (this.options.uploadUrl != null) {
      log(`Resuming upload from provided URL: ${this.options.uploadUrl}`)
      this.url = this.options.uploadUrl
      this._resumeUpload()
      return
    }

    // An upload has not started for the file yet, so we start a new one
    log('Creating a new upload')
    this._createUpload()
  }

  /**
   * Abort any running request and stop the current upload. After abort is called, no event
   * handler will be invoked anymore. You can use the `start` method to resume the upload
   * again.
   * If `shouldTerminate` is true, the `terminate` function will be called to remove the
   * current upload from the server.
   *
   * @param {boolean} shouldTerminate True if the upload should be deleted from the server.
   * @return {Promise} The Promise will be resolved/rejected when the requests finish.
   */
  abort(shouldTerminate) {
    // Stop any parallel partial uploads, that have been started in _startParallelUploads.
    if (this._parallelUploads != null) {
      this._parallelUploads.forEach((upload) => {
        upload.abort(shouldTerminate)
      })
    }

    // Stop any current running request.
    if (this._req !== null) {
      this._req.abort()
      // Note: We do not close the file source here, so the user can resume in the future.
    }
    this._aborted = true

    // Stop any timeout used for initiating a retry.
    if (this._retryTimeout != null) {
      // @ts-expect-error What is a timeout type for Node.js and browsers?
      clearTimeout(this._retryTimeout)
      this._retryTimeout = null
    }

    if (!shouldTerminate || this.url == null) {
      return Promise.resolve()
    }

    return (
      terminate(this.url, this.options)
        // Remove entry from the URL storage since the upload URL is no longer valid.
        .then(() => this._removeFromUrlStorage())
    )
  }

  _emitHttpError(req, res, message, causingErr?) {
    this._emitError(new DetailedError(message, causingErr, req, res))
  }

  _emitError(err) {
    // Do not emit errors, e.g. from aborted HTTP requests, if the upload has been stopped.
    if (this._aborted) return

    // Check if we should retry, when enabled, before sending the error to the user.
    if (this.options.retryDelays != null) {
      // We will reset the attempt counter if
      // - we were already able to connect to the server (offset != null) and
      // - we were able to upload a small chunk of data to the server
      const shouldResetDelays = this._offset != null && this._offset > this._offsetBeforeRetry
      if (shouldResetDelays) {
        this._retryAttempt = 0
      }

      if (shouldRetry(err, this._retryAttempt, this.options)) {
        const delay = this.options.retryDelays[this._retryAttempt++]

        this._offsetBeforeRetry = this._offset

        this._retryTimeout = setTimeout(() => {
          this.start()
        }, delay)
        return
      }
    }

    if (typeof this.options.onError === 'function') {
      this.options.onError(err)
    } else {
      throw err
    }
  }

  /**
   * Publishes notification if the upload has been successfully completed.
   *
   * @api private
   */
  _emitSuccess() {
    if (this.options.removeFingerprintOnSuccess) {
      // Remove stored fingerprint and corresponding endpoint. This causes
      // new uploads of the same file to be treated as a different file.
      this._removeFromUrlStorage()
    }

    if (typeof this.options.onSuccess === 'function') {
      this.options.onSuccess()
    }
  }

  /**
   * Publishes notification when data has been sent to the server. This
   * data may not have been accepted by the server yet.
   *
   * @param {number} bytesSent  Number of bytes sent to the server.
   * @param {number} bytesTotal Total number of bytes to be sent to the server.
   * @api private
   */
  _emitProgress(bytesSent, bytesTotal) {
    if (typeof this.options.onProgress === 'function') {
      this.options.onProgress(bytesSent, bytesTotal)
    }
  }

  /**
   * Publishes notification when a chunk of data has been sent to the server
   * and accepted by the server.
   * @param {number} chunkSize  Size of the chunk that was accepted by the server.
   * @param {number} bytesAccepted Total number of bytes that have been
   *                                accepted by the server.
   * @param {number} bytesTotal Total number of bytes to be sent to the server.
   * @api private
   */
  _emitChunkComplete(chunkSize, bytesAccepted, bytesTotal) {
    if (typeof this.options.onChunkComplete === 'function') {
      this.options.onChunkComplete(chunkSize, bytesAccepted, bytesTotal)
    }
  }

  /**
   * Create a new upload using the creation extension by sending a POST
   * request to the endpoint. After successful creation the file will be
   * uploaded
   *
   * @api private
   */
  _createUpload() {
    if (!this.options.endpoint) {
      this._emitError(new Error('tus: unable to create upload because no endpoint is provided'))
      return
    }

    const req = this._openRequest('POST', this.options.endpoint)

    if (this.options.uploadLengthDeferred) {
      req.setHeader('Upload-Defer-Length', 1)
    } else {
      req.setHeader('Upload-Length', this._size)
    }

    // Add metadata if values have been added
    const metadata = encodeMetadata(this.options.metadata)
    if (metadata !== '') {
      req.setHeader('Upload-Metadata', metadata)
    }

    let promise
    if (this.options.uploadDataDuringCreation && !this.options.uploadLengthDeferred) {
      this._offset = 0
      promise = this._addChunkToRequest(req)
    } else {
      if (this.options.protocol === PROTOCOL_IETF_DRAFT_03) {
        req.setHeader('Upload-Complete', '?0')
      }
      promise = this._sendRequest(req)
    }

    promise
      .then((res) => {
        if (!inStatusCategory(res.getStatus(), 200)) {
          this._emitHttpError(req, res, 'tus: unexpected response while creating upload')
          return
        }

        const location = res.getHeader('Location')
        if (location == null) {
          this._emitHttpError(req, res, 'tus: invalid or missing Location header')
          return
        }

        this.url = resolveUrl(this.options.endpoint, location)
        log(`Created upload at ${this.url}`)

        if (typeof this.options.onUploadUrlAvailable === 'function') {
          this.options.onUploadUrlAvailable()
        }

        if (this._size === 0) {
          // Nothing to upload and file was successfully created
          this._emitSuccess()
          if (this._source) this._source.close()
          return
        }

        this._saveUploadInUrlStorage().then(() => {
          if (this.options.uploadDataDuringCreation) {
            this._handleUploadResponse(req, res)
          } else {
            this._offset = 0
            this._performUpload()
          }
        })
      })
      .catch((err) => {
        this._emitHttpError(req, null, 'tus: failed to create upload', err)
      })
  }

  /*
   * Try to resume an existing upload. First a HEAD request will be sent
   * to retrieve the offset. If the request fails a new upload will be
   * created. In the case of a successful response the file will be uploaded.
   *
   * @api private
   */
  _resumeUpload() {
    const req = this._openRequest('HEAD', this.url)
    const promise = this._sendRequest(req)

    promise
      .then((res) => {
        const status = res.getStatus()
        if (!inStatusCategory(status, 200)) {
          // If the upload is locked (indicated by the 423 Locked status code), we
          // emit an error instead of directly starting a new upload. This way the
          // retry logic can catch the error and will retry the upload. An upload
          // is usually locked for a short period of time and will be available
          // afterwards.
          if (status === 423) {
            this._emitHttpError(req, res, 'tus: upload is currently locked; retry later')
            return
          }

          if (inStatusCategory(status, 400)) {
            // Remove stored fingerprint and corresponding endpoint,
            // on client errors since the file can not be found
            this._removeFromUrlStorage()
          }

          if (!this.options.endpoint) {
            // Don't attempt to create a new upload if no endpoint is provided.
            this._emitHttpError(
              req,
              res,
              'tus: unable to resume upload (new upload cannot be created without an endpoint)',
            )
            return
          }

          // Try to create a new upload
          this.url = null
          this._createUpload()
          return
        }

        const offsetStr = res.getHeader('Upload-Offset')
        if (offsetStr === undefined) {
          this._emitHttpError(req, res, 'tus: missing Upload-Offset header')
          return
        }
        const offset = parseInt(offsetStr, 10)
        if (Number.isNaN(offset)) {
          this._emitHttpError(req, res, 'tus: invalid Upload-Offset header')
          return
        }

        // @ts-expect-error parseInt also handles undefined as we want it to
        const length = parseInt(res.getHeader('Upload-Length'), 10)
        if (
          Number.isNaN(length) &&
          !this.options.uploadLengthDeferred &&
          this.options.protocol === PROTOCOL_TUS_V1
        ) {
          this._emitHttpError(req, res, 'tus: invalid or missing length value')
          return
        }

        if (typeof this.options.onUploadUrlAvailable === 'function') {
          this.options.onUploadUrlAvailable()
        }

        this._saveUploadInUrlStorage().then(() => {
          // Upload has already been completed and we do not need to send additional
          // data to the server
          if (offset === length) {
            this._emitProgress(length, length)
            this._emitSuccess()
            return
          }

          this._offset = offset
          this._performUpload()
        })
      })
      .catch((err) => {
        this._emitHttpError(req, null, 'tus: failed to resume upload', err)
      })
  }

  /**
   * Start uploading the file using PATCH requests. The file will be divided
   * into chunks as specified in the chunkSize option. During the upload
   * the onProgress event handler may be invoked multiple times.
   *
   * @api private
   */
  _performUpload() {
    // If the upload has been aborted, we will not send the next PATCH request.
    // This is important if the abort method was called during a callback, such
    // as onChunkComplete or onProgress.
    if (this._aborted) {
      return
    }

    let req

    // Some browser and servers may not support the PATCH method. For those
    // cases, you can tell tus-js-client to use a POST request with the
    // X-HTTP-Method-Override header for simulating a PATCH request.
    if (this.options.overridePatchMethod) {
      req = this._openRequest('POST', this.url)
      req.setHeader('X-HTTP-Method-Override', 'PATCH')
    } else {
      req = this._openRequest('PATCH', this.url)
    }

    req.setHeader('Upload-Offset', this._offset)
    const promise = this._addChunkToRequest(req)

    promise
      .then((res) => {
        if (!inStatusCategory(res.getStatus(), 200)) {
          this._emitHttpError(req, res, 'tus: unexpected response while uploading chunk')
          return
        }

        this._handleUploadResponse(req, res)
      })
      .catch((err) => {
        // Don't emit an error if the upload was aborted manually
        if (this._aborted) {
          return
        }

        this._emitHttpError(req, null, `tus: failed to upload chunk at offset ${this._offset}`, err)
      })
  }

  /**
   * _addChunktoRequest reads a chunk from the source and sends it using the
   * supplied request object. It will not handle the response.
   *
   * @api private
   */
  _addChunkToRequest(req) {
    const start = this._offset
    let end = this._offset + this.options.chunkSize

    req.setProgressHandler((bytesSent) => {
      this._emitProgress(start + bytesSent, this._size)
    })

    req.setHeader('Content-Type', 'application/offset+octet-stream')

    // The specified chunkSize may be Infinity or the calcluated end position
    // may exceed the file's size. In both cases, we limit the end position to
    // the input's total size for simpler calculations and correctness.
    // @ts-expect-error _size is set here
    if ((end === Infinity || end > this._size) && !this.options.uploadLengthDeferred) {
      // @ts-expect-error _size is set here
      end = this._size
    }

    // @ts-expect-error _source is set here
    return this._source.slice(start, end).then(({ value, done }) => {
      const valueSize = value && value.size ? value.size : 0

      // If the upload length is deferred, the upload size was not specified during
      // upload creation. So, if the file reader is done reading, we know the total
      // upload size and can tell the tus server.
      if (this.options.uploadLengthDeferred && done) {
        this._size = this._offset + valueSize
        req.setHeader('Upload-Length', this._size)
      }

      // The specified uploadSize might not match the actual amount of data that a source
      // provides. In these cases, we cannot successfully complete the upload, so we
      // rather error out and let the user know. If not, tus-js-client will be stuck
      // in a loop of repeating empty PATCH requests.
      // See https://community.transloadit.com/t/how-to-abort-hanging-companion-uploads/16488/13
      const newSize = this._offset + valueSize
      if (!this.options.uploadLengthDeferred && done && newSize !== this._size) {
        return Promise.reject(
          new Error(
            `upload was configured with a size of ${this._size} bytes, but the source is done after ${newSize} bytes`,
          ),
        )
      }

      if (value === null) {
        return this._sendRequest(req)
      }

      if (this.options.protocol === PROTOCOL_IETF_DRAFT_03) {
        req.setHeader('Upload-Complete', done ? '?1' : '?0')
      }
      this._emitProgress(this._offset, this._size)
      return this._sendRequest(req, value)
    })
  }

  /**
   * _handleUploadResponse is used by requests that haven been sent using _addChunkToRequest
   * and already have received a response.
   *
   * @api private
   */
  _handleUploadResponse(req, res) {
    const offset = parseInt(res.getHeader('Upload-Offset'), 10)
    if (Number.isNaN(offset)) {
      this._emitHttpError(req, res, 'tus: invalid or missing offset value')
      return
    }

    this._emitProgress(offset, this._size)
    this._emitChunkComplete(offset - this._offset, offset, this._size)

    this._offset = offset

    if (offset === this._size) {
      // Yay, finally done :)
      this._emitSuccess()
      if (this._source) this._source.close()
      return
    }

    this._performUpload()
  }

  /**
   * Create a new HTTP request object with the given method and URL.
   *
   * @api private
   */
  _openRequest(method, url) {
    const req = openRequest(method, url, this.options)
    this._req = req
    return req
  }

  /**
   * Remove the entry in the URL storage, if it has been saved before.
   *
   * @api private
   */
  _removeFromUrlStorage() {
    if (!this._urlStorageKey) return

    this._urlStorage.removeUpload(this._urlStorageKey).catch((err) => {
      this._emitError(err)
    })
    this._urlStorageKey = null
  }

  /**
   * Add the upload URL to the URL storage, if possible.
   *
   * @api private
   */
  _saveUploadInUrlStorage() {
    // We do not store the upload URL
    // - if it was disabled in the option, or
    // - if no fingerprint was calculated for the input (i.e. a stream), or
    // - if the URL is already stored (i.e. key is set alread).
    if (
      !this.options.storeFingerprintForResuming ||
      !this._fingerprint ||
      this._urlStorageKey !== null
    ) {
      return Promise.resolve()
    }

    const storedUpload: PreviousUpload = {
      size: this._size,
      metadata: this.options.metadata,
      creationTime: new Date().toString(),
    }

    if (this._parallelUploads) {
      // Save multiple URLs if the parallelUploads option is used ...
      storedUpload.parallelUploadUrls = this._parallelUploadUrls
    } else {
      // ... otherwise we just save the one available URL.
      // @ts-expect-error We still have to figure out the null/undefined situation.
      storedUpload.uploadUrl = this.url
    }

    return this._urlStorage.addUpload(this._fingerprint, storedUpload).then((urlStorageKey) => {
      // TODO: Handle cases when urlStorageKey is undefined
      this._urlStorageKey = urlStorageKey || null
    })
  }

  /**
   * Send a request with the provided body.
   *
   * @api private
   */
  _sendRequest(req: HttpRequest<S>, body?: S) {
    return sendRequest(req, body, this.options)
  }
}

function encodeMetadata(metadata) {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${Base64.encode(String(value))}`)
    .join(',')
}

/**
 * Checks whether a given status is in the range of the expected category.
 * For example, only a status between 200 and 299 will satisfy the category 200.
 *
 * @api private
 */
function inStatusCategory(status, category) {
  return status >= category && status < category + 100
}

/**
 * Create a new HTTP request with the specified method and URL.
 * The necessary headers that are included in every request
 * will be added, including the request ID.
 *
 * @api private
 */
function openRequest(method, url, options) {
  const req = options.httpStack.createRequest(method, url)

  if (options.protocol === PROTOCOL_IETF_DRAFT_03) {
    req.setHeader('Upload-Draft-Interop-Version', '5')
  } else {
    req.setHeader('Tus-Resumable', '1.0.0')
  }
  const headers = options.headers || {}

  Object.entries(headers).forEach(([name, value]) => {
    req.setHeader(name, value)
  })

  if (options.addRequestId) {
    const requestId = uuid()
    req.setHeader('X-Request-ID', requestId)
  }

  return req
}

/**
 * Send a request with the provided body while invoking the onBeforeRequest
 * and onAfterResponse callbacks.
 *
 * @api private
 */
async function sendRequest<F, S>(
  req: HttpRequest<S>,
  body: S | undefined,
  options: UploadOptions<F, S>,
): Promise<HttpResponse> {
  if (typeof options.onBeforeRequest === 'function') {
    await options.onBeforeRequest(req)
  }

  const res = await req.send(body)

  if (typeof options.onAfterResponse === 'function') {
    await options.onAfterResponse(req, res)
  }

  return res
}

/**
 * Checks whether the browser running this code has internet access.
 * This function will always return true in the node.js environment
 *
 * @api private
 */
function isOnline(): boolean {
  let online = true
  // Note: We don't reference `window` here because the navigator object also exists
  // in a Web Worker's context.
  // eslint-disable-next-line no-undef
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    online = false
  }

  return online
}

/**
 * Checks whether or not it is ok to retry a request.
 * @param {Error|DetailedError} err the error returned from the last request
 * @param {number} retryAttempt the number of times the request has already been retried
 * @param {object} options tus Upload options
 *
 * @api private
 */
function shouldRetry(err, retryAttempt, options) {
  // We only attempt a retry if
  // - retryDelays option is set
  // - we didn't exceed the maxium number of retries, yet, and
  // - this error was caused by a request or it's response and
  // - the error is server error (i.e. not a status 4xx except a 409 or 423) or
  // a onShouldRetry is specified and returns true
  // - the browser does not indicate that we are offline
  if (
    options.retryDelays == null ||
    retryAttempt >= options.retryDelays.length ||
    err.originalRequest == null
  ) {
    return false
  }

  if (options && typeof options.onShouldRetry === 'function') {
    return options.onShouldRetry(err, retryAttempt, options)
  }

  return defaultOnShouldRetry(err)
}

/**
 * determines if the request should be retried. Will only retry if not a status 4xx except a 409 or 423
 * @param {DetailedError} err
 * @returns {boolean}
 */
function defaultOnShouldRetry(err) {
  const status = err.originalResponse ? err.originalResponse.getStatus() : 0
  return (!inStatusCategory(status, 400) || status === 409 || status === 423) && isOnline()
}

/**
 * Resolve a relative link given the origin as source. For example,
 * if a HTTP request to http://example.com/files/ returns a Location
 * header with the value /upload/abc, the resolved URL will be:
 * http://example.com/upload/abc
 */
function resolveUrl(origin, link) {
  return new URL(link, origin).toString()
}

/**
 * Calculate the start and end positions for the parts if an upload
 * is split into multiple parallel requests.
 *
 * @param {number} totalSize The byte size of the upload, which will be split.
 * @param {number} partCount The number in how many parts the upload will be split.
 * @return {object[]}
 * @api private
 */
function splitSizeIntoParts(totalSize, partCount) {
  const partSize = Math.floor(totalSize / partCount)
  const parts: { start: number; end: number }[] = []

  for (let i = 0; i < partCount; i++) {
    parts.push({
      start: partSize * i,
      end: partSize * (i + 1),
    })
  }

  parts[partCount - 1].end = totalSize

  return parts
}

/**
 * Use the Termination extension to delete an upload from the server by sending a DELETE
 * request to the specified upload URL. This is only possible if the server supports the
 * Termination extension. If the `options.retryDelays` property is set, the method will
 * also retry if an error ocurrs.
 *
 * @param {String} url The upload's URL which will be terminated.
 * @param {object} options Optional options for influencing HTTP requests.
 * @return {Promise} The Promise will be resolved/rejected when the requests finish.
 */
export function terminate<F, S>(url: string, options: UploadOptions<F, S>): Promise<void> {
  const req = openRequest('DELETE', url, options)

  return sendRequest(req, undefined, options)
    .then((res) => {
      // A 204 response indicates a successfull request
      if (res.getStatus() === 204) {
        return
      }

      throw new DetailedError(
        'tus: unexpected response while terminating upload',
        undefined,
        req,
        res,
      )
    })
    .catch((err) => {
      if (!(err instanceof DetailedError)) {
        err = new DetailedError('tus: failed to terminate upload', err, req)
      }

      if (!shouldRetry(err, 0, options)) {
        throw err
      }

      // Instead of keeping track of the retry attempts, we remove the first element from the delays
      // array. If the array is empty, all retry attempts are used up and we will bubble up the error.
      // We recursively call the terminate function will removing elements from the retryDelays array.
      const delay = options.retryDelays[0]
      const remainingDelays = options.retryDelays.slice(1)
      const newOptions = {
        ...options,
        retryDelays: remainingDelays,
      }
      return new Promise((resolve) => {
        setTimeout(resolve, delay)
      }).then(() => terminate(url, newOptions))
    })
}
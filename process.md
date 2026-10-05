Part 1: Upload endpoint (Express + multer)
* Endpoint only accepts multipart/form-data
    * Add a small check that returns 415 Unsupported Media Type when the Content-Type is anything else.
    * Accept only a single file
    * Save the file to disk: Audio files can be hundreds of MB
* Add an entry to the job_processing message queue - job_id, the audio file url (or path), status of job to ‘queued’
* We return 202 to the client with the job_id in the response.
    * The client can then save the job_id and use polling to request our /status endpoint with the job_id
    * If the job is completed, they will get the transcription back from the /status endpoint. 

Part 2: Normalize the audio files (mp3, etc) 
* Service worker 1 pulls the job with status ‘queued’ from the job_processing message queue, and use ffmpeg/fluent-ffmpeg and convert into standardized audio format like 16KHz mono WAV file.
* It saves the standardized audio file in disk and update the job status to ‘standardised’ and updates the audio file uri (or path)
* The service worker 1 also deletes the original audio file at this point to save space, as we have the standardized audio file.
* Now that we have the standardized audio file, we will chunk it to handle large files. Voice Activity Detection (VAD) techniques are to find the natural pauses in speech and slices the file during those silent gaps.
* The service worker 1 adds an entry to the chunk_processing message queue for each chunk - chunk_job_id , job_id (original), chunk uri (or path), status of job ‘not_started’

Part 3: Chunking
* The service worker 2 is listening on the chunk_processing message queue, and whenever it has a chunk_job_id with status ‘not_started’ it takes that file, and passes to our Voice Processor. And sets the chunk status to ‘processing’
* The service worker 2 will pick the chunk and pass to the Transcribing Blackbox running faster-whisper and WhisperX libraries
* The service worker will process the chunks in a linear fashion. Chunk 1, then chunk 2, chunk 3 and so on, and also each chunk will have its length stored (which we will use to keep the timestamps in sync)
* When the process completes, and returns the json file, the service worker 2 applies an time offset adjustment (to keep the timestamps in sync) for each chunk, and updates the chunk status to ‘completed’

Part 4: Merging back
* The service worker 2 once all the chunks (or a single chunk) are converted on job_id, it combines the json objects into one object and updates the job_processing queue’s status to ‘completed’, and saves the transcription back in column transcription
* The /status endpoint will now return the transcription back to the client when the next round of polling happens 

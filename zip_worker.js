// zip-worker.js

// IMPORTANT: This line loads the zip.js library directly into the worker's scope.
// The path here MUST be correct relative to the location of this 'zip-worker.js' file.
// For example, if 'zip-full.min.js' is in a 'lib' folder next to 'zip-worker.js', use './lib/zip-full.min.js'
importScripts('zip-full.min.js'); // Common case: both files in the same directory

// This global error handler for the worker thread catches any uncaught exceptions
// that occur within the worker's code. This is crucial for debugging.
self.onerror = function(event) {
    console.error("Error INSIDE Web Worker:", {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error // The actual Error object, if available
    });
    // You can also post this error back to the main thread immediately
    // without waiting for the onmessage promise to resolve.
    self.postMessage({
        status: 'worker_internal_error',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
    });
    // Returning true prevents the error from propagating further (e.g., to the main window.onerror)
    return true;
};


// This is the main entry point for messages coming from the main thread.
// All code inside this 'onmessage' listener executes in the worker thread.
self.onmessage = async (event) => {
    // Destructure the data sent from the main thread.
    // 'id' is used to correlate the response back to a specific gallery configuration.
    const { id, zipUrl, password } = event.data;

    try {
        // Step 1: Fetch the ZIP file.
        // This network request is initiated by the worker, off the main thread.
        const response = await fetch(zipUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch ZIP file: ${response.statusText} (Status: ${response.status})`);
        }
        const zipBlob = await response.blob();

        // Step 2: Initialize the ZipReader and get entries.
        // These operations, including decryption, happen within the worker thread.
        const reader = new zip.ZipReader(new zip.BlobReader(zipBlob), { password: password });
        const entries = await reader.getEntries();
        await reader.close(); // Close the reader once entries are obtained

        const imageBlobInfo = []; // Array to store extracted image blobs and their filenames

        // Step 3: Iterate through entries and extract image data.
        for (const entry of entries) {
            // Check if the entry is a common image file type.
            if (entry.filename.match(/\.(jpeg|jpg|png|gif|bmp|webp)$/i)) { // Added more common image types
                try {
                    const blobWriter = new zip.BlobWriter();
                    // entry.getData() is the core operation where decryption and decompression occur.
                    // This is the computationally intensive part, now running off the main thread.
                    const imageBlob = await entry.getData(blobWriter);
                    
                    // Store the extracted blob and its original filename.
                    imageBlobInfo.push({
                        blob: imageBlob,
                        filename: entry.filename
                    });
                } catch (entryError) {
                    // This catch block handles errors specific to individual entry processing (e.g., a corrupted file inside the zip).
                    if (entryError.message === zip.ERR_INVALID_PASSWORD || entryError.message === zip.ERR_ENCRYPTED) {
                        // If a password error specifically occurs during getData(), re-throw it.
                        // It will be caught by the outer try-catch and sent back as a password error.
                        throw new Error(zip.ERR_INVALID_PASSWORD);
                    } else {
                        console.warn(`Worker: Could not process image ${entry.filename} from ${zipUrl}:`, entryError.message);
                        // We continue processing other files even if one fails, unless it's a password issue.
                    }
                }
            }
        }

        // Step 4: Send the results back to the main thread.
        // Blobs are efficiently transferred (not copied) if the browser supports transferable objects.
        self.postMessage({
            id: id,      // Correlate this response with the request from the main thread
            status: 'success',
            images: imageBlobInfo // Array of { blob: Blob, filename: string } objects
        });

    } catch (error) {
        // This catch block handles larger errors:
        // - Fetch errors (e.g., 404 for the ZIP file)
        // - Initial ZipReader errors (e.g., cannot open ZIP, wrong global password)
        // - Password errors re-thrown from individual entry processing.

        // Send an error message back to the main thread.
        self.postMessage({
            id: id,
            status: 'error',
            message: error.message, // The error message string
            isPasswordError: (error.message === zip.ERR_INVALID_PASSWORD || error.message === zip.ERR_ENCRYPTED)
        });
    }
};

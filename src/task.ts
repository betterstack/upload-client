import * as T from "./types";
import {ServiceError} from "./errors";

export class UploadBtnTask {

  private readonly opts: T.UploadBtnTaskOptions;
  private readonly apiUrl: string;

  private abort: boolean = false;
  private executed: boolean = false;
  private progress: T.ProgressCallback;

  constructor(opts: T.UploadBtnTaskOptions) {
    this.opts = opts;
    // @ts-ignore
    this.apiUrl = opts.isTest ?
      "http://localhost:3002/v1/signed-urls" :
      "https://upload-api.betterstack.dev/v1/signed-urls";
    this.progress = () => {};
  }

  public start = async (): Promise<T.UploadedFile[]> => {
    try {

      const { files, providerId } = this.opts;

      const throwUploadError = this.opts.throwUploadError !== false;

      this.log("UploadClient: Init Task");
      this.check();
      this.executed = true;

      // Construct progress
      this.log("UploadClient: Start progress");
      const progress: T.TaskUploadProgress = {
        totalBytes: files.reduce((a, f) => a + f.file.size, 0),
        loadedBytes: 0,
        loadedPercent: 0,
        filesBytes: files.map((f) => f.file.size),
        filesLoadedBytes: files.map(() => 0),
        filesLoadedPercent: files.map(() => 0),
      };
      this.progress({
        ...progress,
        filesBytes: [...progress.filesBytes],
        filesLoadedBytes: [...progress.filesLoadedBytes],
        filesLoadedPercent: [...progress.filesLoadedPercent],
      });

      this.log("UploadClient: Get signed URLS");
      const signResponse = await this.getSignedUrls({
        apiKey: this.opts.apiKey,
        providerId: providerId,
        files: files.map((f) => ({
          key: f.key || f.file.name,
          acl: f.acl,
          type: f.file.type,
        })),
      });
      if (signResponse.files.length !== files.length) {
        throw new ServiceError("mismatch_length_signed_urls_and_files");
      }

      this.log("UploadClient: Upload files");
      const uploadedFiles: T.UploadedFile[] = [];

      for (let i = 0; i < files.length; i++) {

        if (this.abort) { break; }

        const file = files[i].file;
        const key = signResponse.files[i].key;
        const acl = signResponse.files[i].acl;
        const url = signResponse.files[i].signedUrl;

        uploadedFiles[i] = {
          key: key,
          file: file,
        };

        try {
          this.log("UploadClient: Upload file", url, file);
          await this.putObject({
            url, acl, file,
            progressCallback: (bytes, xhr) => {

              progress.filesLoadedBytes[i] = bytes;

              progress.filesLoadedPercent[i] = (bytes / progress.filesBytes[i]) * 100;

              progress.loadedBytes = progress.filesLoadedBytes.reduce((a, v) => a + v, 0);

              progress.loadedPercent = (progress.loadedBytes / progress.totalBytes) * 100;

              if (this.abort) {
                xhr.abort();
              }
              else {
                this.progress({
                  ...progress,
                  filesBytes: [...progress.filesBytes],
                  filesLoadedBytes: [...progress.filesLoadedBytes],
                  filesLoadedPercent: [...progress.filesLoadedPercent],
                });
              }

            },
          });
          if (!throwUploadError) {
            uploadedFiles[i].responseCode = 200;
          }
        }
        catch (e) {
          if (this.abort) {
            if (throwUploadError)
              throw new ServiceError("upload_aborted");
            else {
              uploadedFiles[i].responseCode = 0;
              uploadedFiles[i].errorCode = "upload_aborted";
            }
          }
          else if (e.status) {
            this.log(e);
            if (throwUploadError)
              throw new ServiceError("upload_failed");
            else {
              uploadedFiles[i].responseCode = e.status;
              uploadedFiles[i].errorCode = "upload_failed";
            }
          }
          else {
            this.log(e);
            if (throwUploadError)
              throw new ServiceError("upload_could_not_initiate");
            else {
              uploadedFiles[i].responseCode = 0;
              uploadedFiles[i].errorCode = "upload_could_not_initiate";
            }
          }
        }

      }

      return uploadedFiles;

    }
    catch (e) {
      if (e instanceof ServiceError) {
        throw e;
      }
      throw new ServiceError("internal_error", e);
    }
  }

  public stop = () => {
    this.abort = true;
  }

  public onProgress = (fn: T.ProgressCallback) => {
    this.progress = fn;
  }

  private check = () => {

    const { apiKey, providerId, files } = this.opts;

    if (this.executed) {
      throw new ServiceError("task_already_executed");
    }

    if (this.abort) {
      throw new ServiceError("task_already_aborted");
    }

    if (!apiKey) {
      throw new ServiceError("missing_api_key");
    }

    if (!providerId) {
      throw new ServiceError("missing_provider_id");
    }

    if (!files || !files.length || files.length === 0) {
      throw new ServiceError("task_no_files");
    }

  }

  private getSignedUrls = async (data: T.APIGetSignedUrlsReq): Promise<T.APIGetSignedUrlsRes> => {

    const response = await fetch(this.apiUrl, {
      method: "POST",
      mode: "cors",
      cache: "no-cache",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    const responseData = await response.json();

    if (response.status !== 200) {
      throw new ServiceError(responseData.code);
    }

    return responseData;

  }

  private putObject = ({ url, file, acl, progressCallback }: T.APIPutObjectReq): Promise<XMLHttpRequest> => {
    return new Promise((resolve, reject) => {

      const xhr = new XMLHttpRequest();

      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) {
          if (xhr.status === 200) {
            resolve(xhr);
          }
          else {
            reject(xhr);
          }
        }
      };

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          progressCallback(e.loaded, xhr);
        }
      };

      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", file.type);
      if (acl) {
        xhr.setRequestHeader("x-amz-acl", acl);
      }
      xhr.send(file);

    });
  }

  private log = (...d: any) => {
    if (this.opts.log) {
      console.log(...d);
    }
  }

}
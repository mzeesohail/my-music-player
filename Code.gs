function doGet(e) {

  // Normal Apps Script page
  if (!e || !e.parameter || !e.parameter.action) {
    return HtmlService
      .createHtmlOutputFromFile('Index')
      .setTitle('My Music Player');
  }

  const action = e.parameter.action;
  const callback = e.parameter.callback || '';

  let result;

  try {

    if (action === 'library') {
      result = getMusicLibrary();
    }

    else if (action === 'song') {
      const fileId = e.parameter.id;

      if (!fileId) {
        throw new Error('Missing song ID');
      }

      result = getSongData(fileId);
    }

    else {
      throw new Error('Unknown action');
    }

  }

  catch (error) {

    result = {
      error: error.message
    };

  }


  // JSONP response for GitHub Pages
  if (callback) {

    // Only allow simple JavaScript callback names
    if (!/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(callback)) {

      return ContentService
        .createTextOutput('Invalid callback')
        .setMimeType(ContentService.MimeType.TEXT);

    }

    return ContentService
      .createTextOutput(
        callback + '(' + JSON.stringify(result) + ');'
      )
      .setMimeType(ContentService.MimeType.JAVASCRIPT);

  }


  // Normal JSON response
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);

}


// ========================================
// GET MUSIC LIBRARY
// ========================================

function getMusicLibrary() {

  const folderId =
    '1X-_WZPRgHKOXs2R0eIoBwUV6nQOhKK6J';

  const rootFolder =
    DriveApp.getFolderById(folderId);

  const songs = [];

  scanFolder(
    rootFolder,
    '',
    songs
  );

  return songs;
}


// ========================================
// SCAN FOLDERS
// ========================================

function scanFolder(
  folder,
  folderPath,
  songs
) {

  const files =
    folder.getFiles();

  while (files.hasNext()) {

    const file =
      files.next();

    const mimeType =
      file.getMimeType();

    if (
      mimeType &&
      mimeType.startsWith('audio/')
    ) {

      songs.push({

        name:
          file.getName(),

        id:
          file.getId(),

        type:
          mimeType,

        folder:
          folderPath || 'All Songs'

      });

    }

  }


  const folders =
    folder.getFolders();

  while (folders.hasNext()) {

    const subFolder =
      folders.next();

    let newPath;

    if (folderPath === '') {

      newPath =
        subFolder.getName();

    }

    else {

      newPath =
        folderPath +
        '/' +
        subFolder.getName();

    }

    scanFolder(
      subFolder,
      newPath,
      songs
    );

  }

}


// ========================================
// GET SONG DATA
// ========================================

function getSongData(fileId) {

  const file =
    DriveApp.getFileById(fileId);

  const blob =
    file.getBlob();

  return {

    base64:
      Utilities.base64Encode(
        blob.getBytes()
      ),

    type:
      blob.getContentType(),

    name:
      file.getName()

  };

}

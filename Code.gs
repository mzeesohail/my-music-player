const SHEET_ID = '1620kQ6O0WHtBdUKd4iZLPvc4J-l0WzYsVv2JIU2vsEI';

const MUSIC_FOLDER_ID = '1X-_WZPRgHKOXs2R0eIoBwUV6nQOhKK6J';


// ============================================================
// MAIN WEB APP
// ============================================================

function doGet(e) {

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

    else if (action === 'login') {

      result = recordLogin(
        e.parameter.name,
        e.parameter.email
      );

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


  // ==========================================================
  // JSONP FOR GITHUB PAGES
  // ==========================================================

  if (callback) {

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


  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);

}


// ============================================================
// LOGIN
// ============================================================

function recordLogin(name, email) {

  name = String(name || '').trim();
  email = normalizeEmail(email);

  if (!name) {
    throw new Error('Please enter your name');
  }

  if (!email) {
    throw new Error('Please enter your email');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Please enter a valid email address');
  }


  const lock = LockService.getScriptLock();

  lock.waitLock(10000);

  try {

    const ss =
      SpreadsheetApp.openById(SHEET_ID);


    const usersSheet =
      getOrCreateSheet(
        ss,
        'Users',
        [
          'User ID',
          'Name',
          'Email',
          'First Login',
          'Last Login',
          'Login Count',
          'Status',
          'Role'
        ]
      );


    const loginLogSheet =
      getOrCreateSheet(
        ss,
        'LoginLog',
        [
          'Date/Time',
          'User ID',
          'Name',
          'Email',
          'Action'
        ]
      );


    const userId =
      makeUserId(email);


    /*
      Because the Apps Script runs as the owner,
      getEffectiveUser() identifies the account
      that owns/runs this web app.
    */

    const ownerEmail =
      normalizeEmail(
        Session.getEffectiveUser().getEmail()
      );


    /*
      Your own account automatically becomes Admin.
      Other users become User.
    */

    const role =
      ownerEmail &&
      email === ownerEmail
        ? 'Admin'
        : 'User';


    const now =
      new Date();


    const lastRow =
      usersSheet.getLastRow();


    let existingRow = -1;


    if (lastRow >= 2) {

      const emailValues =
        usersSheet
          .getRange(
            2,
            3,
            lastRow - 1,
            1
          )
          .getValues();


      for (
        let i = 0;
        i < emailValues.length;
        i++
      ) {

        if (
          normalizeEmail(
            emailValues[i][0]
          ) === email
        ) {

          existingRow =
            i + 2;

          break;

        }

      }

    }


    let firstLogin;
    let loginCount;


    if (existingRow === -1) {

      firstLogin =
        now;

      loginCount =
        1;


      usersSheet.appendRow([
        userId,
        name,
        email,
        firstLogin,
        now,
        loginCount,
        'Active',
        role
      ]);

    }

    else {

      const row =
        usersSheet
          .getRange(
            existingRow,
            1,
            1,
            8
          )
          .getValues()[0];


      firstLogin =
        row[3] || now;


      loginCount =
        Number(row[5] || 0) + 1;


      usersSheet
        .getRange(
          existingRow,
          1,
          1,
          8
        )
        .setValues([[
          userId,
          name,
          email,
          firstLogin,
          now,
          loginCount,
          'Active',
          role
        ]]);

    }


    loginLogSheet.appendRow([
      now,
      userId,
      name,
      email,
      'Login'
    ]);


    return {

      ok: true,

      user: {
        id: userId,
        name: name,
        email: email,
        role: role
      }

    };

  }

  finally {

    lock.releaseLock();

  }

}


// ============================================================
// SHEET SETUP
// ============================================================

function getOrCreateSheet(
  spreadsheet,
  sheetName,
  headers
) {

  let sheet =
    spreadsheet.getSheetByName(
      sheetName
    );


  if (!sheet) {

    sheet =
      spreadsheet.insertSheet(
        sheetName
      );

  }


  const firstRow =
    sheet
      .getRange(
        1,
        1,
        1,
        headers.length
      )
      .getValues()[0];


  const empty =
    firstRow.every(
      value => value === ''
    );


  if (empty) {

    sheet
      .getRange(
        1,
        1,
        1,
        headers.length
      )
      .setValues([
        headers
      ]);

  }


  return sheet;

}


// ============================================================
// NORMALIZE EMAIL
// ============================================================

function normalizeEmail(email) {

  return String(email || '')
    .trim()
    .toLowerCase();

}


// ============================================================
// USER ID
// ============================================================

function makeUserId(email) {

  const bytes =
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      email
    );


  return bytes
    .map(function(byte) {

      const value =
        byte < 0
          ? byte + 256
          : byte;

      return value
        .toString(16)
        .padStart(2, '0');

    })
    .join('');

}


// ============================================================
// MUSIC LIBRARY
// ============================================================

function getMusicLibrary() {

  const rootFolder =
    DriveApp.getFolderById(
      MUSIC_FOLDER_ID
    );


  const songs = [];


  scanFolder(
    rootFolder,
    '',
    songs
  );


  return songs;

}


// ============================================================
// SCAN FOLDERS
// ============================================================

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
          folderPath ||
          'All Songs'

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


// ============================================================
// SONG DATA
// ============================================================

function getSongData(fileId) {

  const file =
    DriveApp.getFileById(
      fileId
    );


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

import { Parser } from 'm3u8-parser';
import jBinary from 'jbinary';
import MPEGTS from 'mpegts_to_mp4/mpegts_to_mp4/mpegts';
import { mpegts_to_mp4 as mpegtsToMp4 } from 'mpegts_to_mp4/mpegts_to_mp4/index'; // eslint-disable-line no-use-before-define
import { DEFAULT_VIDEO_FORMAT } from '../constants';

export async function parseM3u8File(uri) {
  const m3u8Parser = new Parser();
  const manifest = await fetch(uri).then(resp => resp.text());
  m3u8Parser.push(manifest);
  m3u8Parser.end();
  const parsedManifest = m3u8Parser.manifest;
  return parsedManifest;
}

export async function fetchRetry(url, options, retryCnt = 3) {
  try {
    return fetch(url, options);
  } catch (err) {
    if (retryCnt <= 1) throw err;
    return fetchRetry(url, options, retryCnt - 1);
  }
}

export function downloadSingleSegment(uri, options = {}, retryCnt = 3) {
  return fetchRetry(uri, options, retryCnt).then(resp => {
    if (resp.ok) {
      return resp.blob();
    }
    throw new Error('下载失败,服务端返回:' + resp.status);
  });
}

export async function downloadSegments(baseUri, segments, format = DEFAULT_VIDEO_FORMAT, progressCallbak) {
  // MP4转化相当耗时,所以当格式为MP4的时候,进度条不能立即更新要在转化完之后才更新 😂
  const totalLen = segments.length;
  let lastChunk;
  return Promise.all(
    segments.map(async (seg, index) => {
      const tsUri = baseUri + seg.uri;
      return downloadSingleSegment(tsUri, {}, 3).then(data => {
        // 如果是MP4格式,记录最后一块数据，并且跳过进度回调，等到待会儿转化为MP4之后再说.
        if (totalLen - 1 === index && format === 'mp4') {
          lastChunk = data;
        } else {
          progressCallbak(data);
        }
        return data;
      });
    })
  ).then(dataChunks => {
    if (format === 'ts') {
      const mp4Blob = new Blob(dataChunks, { type: 'video/mp2t' });
      const link = URL.createObjectURL(mp4Blob);
      return { downloadLink: link };
    } else if (format === 'mp4') {
      const blob = new Blob(dataChunks);
      return new Promise((resolve, reject) => {
        jBinary.load(blob, MPEGTS, (err, mpegts) => {
          if (err) {
            reject(err);
          }
          console.debug('begin to convert mp4', new Date());
          const mp4Obj = mpegtsToMp4(mpegts);
          console.debug('finished', new Date());
          // 开始了...
          progressCallbak(lastChunk);
          resolve({ downloadLink: mp4Obj.toURI('video/mp4') });
        });
      });
    } else {
      throw new Error('Unsupported format.');
    }
  });
}

import { HardDrive } from 'lucide-react';
import { PageHeader } from '../layout';
import { FileBrowser } from '../components/FileBrowser';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const enc = encodeURIComponent;

const storageEndpoints = {
  list: (dirPath: string) => `/storage?path=${enc(dirPath)}`,
  createFolder: '/storage/folders',
  upload: '/storage/upload',
  download: (filePath: string) => `/storage/download?path=${enc(filePath)}`,
  readTextContent: (filePath: string) => `/storage/files/content?path=${enc(filePath)}`,
  writeTextContent: '/storage/files/content',
  delete: (entryPath: string) => `/storage?path=${enc(entryPath)}`,
  reveal: '/storage/reveal',
  rename: '/storage/rename',
};

export function StoragePage() {
  useDocumentTitle('Storage');

  return (
    <>
      <PageHeader
        title="Storage"
        description="Browse, upload, and manage files"
      />
      <FileBrowser
        endpoints={storageEndpoints}
        rootLabel="Storage"
        rootIcon={HardDrive}
        showMultiSelect
        showRename
        showUploadFolder
      />
    </>
  );
}

export const IMAGE_OPTIONS = [
  { label: 'netshoot', value: 'nicolaka/netshoot' },
  { label: 'alpine', value: 'netlab-alpine:v1' },
  { label: 'debian', value: 'netlab-debian:v2' },
  { label: 'ubuntu', value: 'netlab-ubuntu:v2' },
];

export function imageLabel(image: string): string {
  return IMAGE_OPTIONS.find(o => o.value === image)?.label ?? image;
}

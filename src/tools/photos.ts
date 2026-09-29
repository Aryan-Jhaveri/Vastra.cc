import * as queries from '../db/queries.js'
import { saveImage, saveImageFromBase64, deleteImage } from '../storage/images.js'
import type { UserPhoto, AddUserPhotoInput } from '../types/index.js'

export async function addUserPhoto(input: AddUserPhotoInput, userId: string): Promise<UserPhoto> {
  let imageUri: string

  if (input.imagePath) {
    imageUri = await saveImage(input.imagePath, 'user', userId)
  } else if (input.imageBase64) {
    imageUri = await saveImageFromBase64(input.imageBase64, 'user', userId)
  } else {
    throw new Error('addUserPhoto requires either imagePath or imageBase64')
  }

  return queries.insertUserPhoto({
    userId,
    imageUri,
    label: input.label,
    isPrimary: input.isPrimary ? 1 : 0,
  })
}

export async function listUserPhotos(userId: string): Promise<UserPhoto[]> {
  return queries.getUserPhotos(userId)
}

export async function setPrimaryPhoto(id: string, userId: string): Promise<UserPhoto> {
  const updated = queries.setPrimaryPhoto(id, userId)
  if (!updated) throw new Error(`UserPhoto ${id} not found`)
  return updated
}

export async function deleteUserPhoto(id: string, userId: string): Promise<void> {
  const photo = queries.getUserPhotos(userId).find(p => p.id === id)
  if (photo) await deleteImage(photo.imageUri, userId)
  queries.deleteUserPhoto(id, userId)
}

import { searchExplorePlaces, getWishlist, addWishlist, removeWishlist, listExploreItineraries, saveExploreItinerary } from '../services/explore.service.js';

export async function search(req,res,next){ try { const {q,destination}=req.query; res.json({places:await searchExplorePlaces({query:q,destination})}); } catch(e){next(e);} }
export async function wishlist(req,res,next){ try { res.json({places:await getWishlist(req.user.id)}); } catch(e){next(e);} }
export async function add(req,res,next){ try { if(!req.body?.place?.name) return res.status(400).json({error:'Place name is required'}); res.status(201).json({place:await addWishlist(req.user.id,req.body.place)}); } catch(e){next(e);} }
export async function remove(req,res,next){ try { await removeWishlist(req.user.id,decodeURIComponent(req.params.placeKey)); res.json({success:true}); } catch(e){next(e);} }
export async function itineraries(req,res,next){ try { res.json({itineraries:await listExploreItineraries(req.user.id)}); } catch(e){next(e);} }
export async function save(req,res,next){ try { if(!Array.isArray(req.body?.stops)||req.body.stops.length===0) return res.status(400).json({error:'Add at least one place before saving'}); res.status(201).json({itinerary:await saveExploreItinerary(req.user.id,req.body)}); } catch(e){next(e);} }
